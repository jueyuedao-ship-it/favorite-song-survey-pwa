import importlib.util
import json
import sqlite3
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
import sys
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import urllib.parse
import subprocess

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    import mirror
except ModuleNotFoundError:
    mirror = None


def row(id, **fields):
    return dict(id=id, revision=1, created_at='2026-10-01T00:00:00Z',
                updated_at='2026-10-01T00:00:00Z', deleted_at=None, **fields)


def event(n, table, data):
    return dict(sequence=n, table=table, row_id=data['id'], action='upsert',
                occurred_at='2026-10-01T00:00:00Z', row=data)


def page(events, watermark, more=False):
    return dict(schema_version=1, high_watermark=watermark, has_more=more,
                next_cursor=events[-1]['sequence'] if more else watermark, events=events)


class MirrorTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(mirror, 'collector implementation is missing')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = mirror.Mirror(Path(self.tmp.name) / 'mirror.sqlite')
        self.addCleanup(self.db.close)

    def test_full_watermark_is_atomic_and_resumes_after_interruption(self):
        self.db.accept(page([event(1, 'participants', row('p', name='初音'))], 2, True))
        self.assertEqual(self.db.cursor, 0)
        self.assertEqual(self.db.connection.execute('SELECT count(*) FROM participants').fetchone()[0], 0)
        self.db.close()
        self.db = mirror.Mirror(Path(self.tmp.name) / 'mirror.sqlite')
        self.addCleanup(self.db.close)
        self.assertEqual(self.db.request_position(), (1, 2))
        self.db.accept(page([event(2, 'responses', row('r', participant_id='p', version_id=None,
                                                     record_date='2026-10-01', unresolved_title='テレパシー'))], 2))
        self.assertEqual(self.db.cursor, 2)
        self.assertEqual(self.db.connection.execute('SELECT participant_name FROM response_details').fetchone()[0], '初音')

    def test_invalid_page_does_not_advance_or_apply(self):
        good = event(1, 'participants', row('p', name='日本語'))
        bad = event(2, 'participants; DROP TABLE events', row('evil'))
        for value in [page([good, bad], 2), dict(page([good], 1), schema_version=2),
                      dict(page([good], 1), schema_version=True),
                      dict(page([good], 1), next_cursor=3), page([good, good], 2),
                      page([dict(good, table=['participants'])], 1),
                      page([dict(good, row_id='wrong')], 1),
                      page([dict(good, row=dict(good['row'], revision=0))], 1)]:
            with self.subTest(value=value):
                with self.assertRaises(mirror.MirrorError):
                    self.db.accept(value)
                self.assertEqual(self.db.cursor, 0)
                self.assertEqual(self.db.connection.execute('SELECT count(*) FROM events').fetchone()[0], 0)

    def test_frozen_watermark_mismatch_keeps_staged_data_for_resume(self):
        self.db.accept(page([event(1, 'participants', row('p', name='元'))], 3, True))
        with self.assertRaises(mirror.MirrorError):
            self.db.accept(page([event(2, 'works', row('w', title='曲'))], 4, True))
        self.assertEqual(self.db.request_position(), (1, 3))
        self.assertEqual(self.db.cursor, 0)
        self.assertEqual(self.db.connection.execute('SELECT count(*) FROM staged_events').fetchone()[0], 1)
        self.db.accept(page([event(2, 'works', row('w', title='曲')), event(3, 'audit', row('a', table='works', row_id='w'))], 3))
        self.assertEqual(self.db.cursor, 3)

    def test_existing_local_schema_mismatch_preserves_business_database(self):
        self.db.accept(page([event(1, 'participants', row('p', name='残す'))], 1))
        with self.db.connection:
            self.db.set_meta('schema_version', 2)
        self.db.close()
        with self.assertRaises(mirror.MirrorError):
            mirror.Mirror(Path(self.tmp.name) / 'mirror.sqlite')
        with closing(sqlite3.connect(Path(self.tmp.name) / 'mirror.sqlite')) as verify:
            self.assertEqual(verify.execute('SELECT count(*) FROM participants').fetchone()[0], 1)

    def test_repeated_page_and_revision_regression_rejected_without_loss(self):
        first = page([event(1, 'participants', row('p', name='元'))], 1)
        self.db.accept(first)
        with self.assertRaises(mirror.MirrorError):
            self.db.accept(first)
        with self.assertRaises(mirror.MirrorError):
            self.db.accept(page([event(2, 'participants', row('p', name='改ざん'))], 2))
        self.assertEqual(self.db.cursor, 1)
        self.assertEqual(self.db.connection.execute('SELECT name FROM v_participants').fetchone()[0], '元')

    def test_tombstones_original_audits_corrections_and_optional_metadata_preserved(self):
        data = [event(1, 'responses', row('r', participant_id='p', version_id=None, record_date='2026-10-01')),
                event(2, 'responses', dict(row('r', participant_id='p', version_id=None, record_date='2026-10-01'), revision=2, deleted_at='2026-10-01T01:00:00Z')),
                event(3, 'audit', row('a', table='responses', row_id='r', before=None, after={'original':'値'})),
                event(4, 'audit_corrections', row('c', audit_id='a', reason='訂正', corrected={'name':'修正'})),
                event(5, 'sources', row('s', version_id='v', url='https://example.com', metadata={'author_name':'歌手'})),
                event(6, 'research_jobs', row('j', metadata_cursor=2, stage='metadata', evidence=[{'metadata':{'title':'歌'}}]))]
        self.db.accept(page(data, 6))
        self.assertEqual(self.db.connection.execute('SELECT count(*) FROM response_details').fetchone()[0], 0)
        self.assertEqual(self.db.connection.execute('SELECT count(*) FROM v_responses').fetchone()[0], 1)
        self.assertEqual(json.loads(self.db.connection.execute('SELECT data FROM sources').fetchone()[0])['metadata']['author_name'], '歌手')
        self.assertEqual(json.loads(self.db.connection.execute('SELECT event_json FROM events WHERE sequence=3').fetchone()[0]), data[2])
        self.assertEqual(self.db.connection.execute('SELECT count(*) FROM audit_corrections').fetchone()[0], 1)

    def test_all_business_tables_are_allowed_but_credentials_never_are(self):
        names = ['participants','works','versions','entities','aliases','credits','responses','tags',
                 'tag_assignments','sources','research_results','research_jobs','usage','devices','invites',
                 'audit','audit_corrections','sync_status']
        self.db.accept(page([event(i + 1, name, row(name)) for i, name in enumerate(names)], 18))
        for name in names:
            self.assertEqual(self.db.connection.execute(f'SELECT count(*) FROM v_{name}').fetchone()[0], 1)
        for name in ['credentials', 'admin_sessions', 'operations']:
            with self.assertRaises(mirror.MirrorError):
                self.db.accept(page([event(19, name, row('x'))], 19))

    def test_daily_backups_are_immutable_and_retain_thirty_dates(self):
        folder = Path(self.tmp.name) / 'backups'
        for offset in range(35):
            self.db.backup(folder, date(2026, 9, 1) + timedelta(days=offset))
        files = sorted(folder.glob('mirror-*.sqlite'))
        self.assertEqual(len(files), 30)
        self.assertEqual(files[0].name, 'mirror-2026-09-06.sqlite')
        before = files[-1].read_bytes()
        self.db.accept(page([event(1, 'participants', row('p', name='new'))], 1))
        self.db.backup(folder, date(2026, 10, 5))
        self.assertEqual(files[-1].read_bytes(), before)
        with closing(sqlite3.connect(files[-1])) as backup:
            self.assertEqual(backup.execute('SELECT value FROM mirror_meta WHERE key="cursor"').fetchone()[0], '0')


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(mirror, 'collector implementation is missing')

    def test_cloud_urls_require_https_workers_origin_and_complete_api_prefix(self):
        self.assertEqual(mirror.validate_api('https://favorite-song-survey-api.demo.workers.dev/api/v1'),
                         'https://favorite-song-survey-api.demo.workers.dev/api/v1')
        for value in ['https://evil.test/api/v1', 'http://localhost/api/v1', 'https://a.workers.dev',
                      'https://secret@a.b.workers.dev/api/v1', 'https://a.b.workers.dev/api/v1?token=x']:
            with self.assertRaises(mirror.MirrorError):
                mirror.validate_api(value)
        self.assertEqual(mirror.validate_api('http://127.0.0.1:8791/api/v1', True), 'http://127.0.0.1:8791/api/v1')

    def test_ack_generates_events_but_run_is_bounded_and_committed_cursor_ahead_of_ack(self):
        class Feed:
            def __init__(self):
                self.events = [event(1, 'participants', row('p', name='名前'))]
                self.acks = []
            def feed(self, cursor, watermark):
                watermark = len(self.events) if watermark is None else watermark
                return page([e for e in self.events if cursor < e['sequence'] <= watermark], watermark)
            def ack(self, collector_id, cursor):
                self.acks.append(cursor)
                self.events.extend([event(2, 'sync_status', row('sync', collector_id=collector_id, cursor=cursor, schema_version=1)),
                                    event(3, 'audit', row('a', table='sync_status', row_id='sync'))])
                return row('sync', collector_id=collector_id, cursor=cursor, schema_version=1)
        with tempfile.TemporaryDirectory() as directory:
            with mirror.Mirror(Path(directory) / 'mirror.sqlite') as db:
                feed = Feed()
                mirror.sync_once(db, feed, 'pc', Path(directory) / 'backups')
                self.assertEqual(feed.acks, [1])
                self.assertEqual(db.cursor, 3)
                self.assertEqual(db.ack_cursor, 1)
                self.assertEqual(db.connection.execute('SELECT count(*) FROM audit').fetchone()[0], 1)

    def test_network_interruption_retries_from_staged_page_and_never_acknowledges_ahead(self):
        class Feed:
            fail = True
            acks = []
            def feed(self, cursor, watermark):
                if cursor >= 2:
                    return page([], 2)
                if cursor == 0:
                    return page([event(1, 'participants', row('p', name='名前'))], 2, True)
                if self.fail:
                    raise mirror.MirrorError('HTTP 503')
                return page([event(2, 'works', row('w', title='歌'))], 2)
            def ack(self, collector_id, cursor):
                self.acks.append(cursor)
                return row('sync', collector_id=collector_id, cursor=cursor, schema_version=1)
        with tempfile.TemporaryDirectory() as directory:
            with mirror.Mirror(Path(directory) / 'mirror.sqlite') as db:
                transport = Feed()
                with self.assertRaises(mirror.MirrorError):
                    mirror.sync_once(db, transport, 'pc', Path(directory) / 'backups')
                self.assertEqual(transport.acks, [])
                self.assertEqual(db.cursor, 0)
                transport.fail = False
                mirror.sync_once(db, transport, 'pc', Path(directory) / 'backups')
                self.assertEqual(transport.acks, [2])

    def test_failed_ack_keeps_ack_checkpoint_and_still_backs_up_committed_rows(self):
        class Feed:
            def feed(self, cursor, watermark):
                return page([event(1, 'works', row('w', title='曲'))], 1)
            def ack(self, collector_id, cursor):
                return row('sync', collector_id=collector_id, cursor=cursor + 1, schema_version=1)
        with tempfile.TemporaryDirectory() as directory:
            with mirror.Mirror(Path(directory) / 'mirror.sqlite') as db:
                folder = Path(directory) / 'backups'
                with self.assertRaises(mirror.MirrorError):
                    mirror.sync_once(db, Feed(), 'pc', folder)
                self.assertEqual(db.cursor, 1)
                self.assertEqual(db.ack_cursor, 0)
                self.assertEqual(len(list(folder.glob('mirror-*.sqlite'))), 1)

    def test_real_http_authorization_envelope_and_redacted_errors(self):
        observed = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                observed.append(dict(path=self.path, authorization=self.headers.get('Authorization'), agent=self.headers.get('User-Agent')))
                if self.path.endswith('/fail'):
                    self.send_response(401)
                    self.end_headers()
                    self.wfile.write(b'fixture-secret and raw-provider-error')
                    return
                if self.path.endswith('/redirect'):
                    self.send_response(302)
                    self.send_header('Location', '/api/v1/leak')
                    self.end_headers()
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(dict(data=page([], 0))).encode())
        with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                transport = mirror.Transport(f'http://127.0.0.1:{server.server_port}/api/v1', 'fixture-secret', True)
                self.assertEqual(transport.feed(0, None)['high_watermark'], 0)
                self.assertEqual(observed[0]['authorization'], 'Bearer fixture-secret')
                self.assertEqual(observed[0]['agent'], 'FavoriteSongSurvey-PCMirror/1.0')
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(observed[0]['path']).query)
                self.assertEqual(query['schema_version'], ['1'])
                for path in ['/fail', '/redirect']:
                    with self.assertRaises(mirror.MirrorError) as caught:
                        transport.request(path)
                    self.assertNotIn('fixture-secret', str(caught.exception))
                    self.assertNotIn('raw-provider-error', str(caught.exception))
                self.assertEqual(len(observed), 3)
            finally:
                server.shutdown()
                thread.join()

    def test_configure_cli_accepts_bearer_only_via_stdin_and_writes_private_config(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            config = directory / 'collector.json'
            command = [sys.executable, str(Path(mirror.__file__)), 'configure', '--config', str(config),
                       '--api-base', 'http://127.0.0.1:8791/api/v1', '--database', str(directory / 'mirror.sqlite'),
                       '--backups', str(directory / 'backups'), '--development']
            result = subprocess.run(command, input=json.dumps(dict(sync_token='fixture-stdin-token')), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('fixture-stdin-token', result.stdout + result.stderr + str(command))
            settings = mirror.load_config(config)
            self.assertEqual(settings['sync_token'], 'fixture-stdin-token')
            self.assertEqual(settings['database'], str((directory / 'mirror.sqlite').resolve()))


if __name__ == '__main__':
    unittest.main()
