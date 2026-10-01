"""One-way schema-1 business mirror. Python 3.11+, standard library only."""
import argparse
from contextlib import closing
from datetime import date, datetime, timezone, timedelta
import ipaddress
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SCHEMA_VERSION = 1
# These names/columns are local constants, never supplied by the server.
COLUMNS = {
    'participants': 'name', 'works': 'title manual_lock',
    'versions': 'work_id title kind reference_url uploader_entity_id research_status manual_lock',
    'entities': 'name kind manual_lock', 'aliases': 'entity_id name',
    'credits': 'version_id entity_id role source_id confirmed manual_lock',
    'responses': 'participant_id version_id record_date unresolved_title artist_hint reference_url',
    'tags': 'name category criterion active',
    'tag_assignments': 'version_id tag_id evidence source_id origin confirmed manual_lock',
    'sources': 'version_id url title excerpt checked_at origin metadata',
    'research_results': 'version_id model dictionary_version analysis_version source_ids payload',
    'research_jobs': 'version_id response_id query candidates status attempts next_attempt_at last_error lease_until dictionary_version analysis_version stage evidence analysis metadata_cursor catalog_cursor',
    'usage': 'month tavily_credits tavily_credit_cap groq_requests last_error',
    'devices': 'participant_id label revoked_at', 'invites': 'participant_id expires_at claimed_at',
    'audit': 'table row_id action actor_id actor_type participant_id before after effective',
    'audit_corrections': 'audit_id reason corrected actor_id',
    'sync_status': 'collector_id cursor schema_version',
}


class MirrorError(Exception):
    """Sanitized, actionable collector failure; never embed upstream bodies."""


def integer(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


class Mirror:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path, timeout=20)
        self.connection.execute('CREATE TABLE IF NOT EXISTS mirror_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
        stored_schema = self.meta('schema_version')
        if stored_schema is not None and stored_schema != '1':
            self.connection.close()
            raise MirrorError('Local schema mismatch; preserve database and update collector')
        self.connection.execute('PRAGMA journal_mode=WAL')
        self.connection.execute('PRAGMA synchronous=FULL')
        with self.connection:
            self.connection.execute('CREATE TABLE IF NOT EXISTS mirror_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
            for key, value in [('schema_version', '1'), ('cursor', '0'), ('ack_cursor', '0')]:
                self.connection.execute('INSERT OR IGNORE INTO mirror_meta VALUES(?,?)', (key, value))
            self.connection.execute('CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY,event_json TEXT NOT NULL CHECK(json_valid(event_json)))')
            self.connection.execute('CREATE TABLE IF NOT EXISTS staged_events(sequence INTEGER PRIMARY KEY,event_json TEXT NOT NULL CHECK(json_valid(event_json)))')
            for table, fields in COLUMNS.items():
                self.connection.execute(f'CREATE TABLE IF NOT EXISTS "{table}" (id TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data)),revision INTEGER GENERATED ALWAYS AS (json_extract(data,\'$.revision\')) STORED)')
                columns = ['id', 'revision'] + [f'json_extract(data,\'$.{field}\') AS "{field}"' for field in ('created_at updated_at deleted_at ' + fields).split()]
                self.connection.execute(f'CREATE VIEW IF NOT EXISTS "v_{table}" AS SELECT ' + ','.join(columns) + f' FROM "{table}"')
            self.connection.execute('''CREATE VIEW IF NOT EXISTS response_details AS
                SELECT r.id AS response_id,r.participant_id,p.name AS participant_name,r.version_id,
                r.record_date,v.work_id,w.title AS work_title,v.title AS version_title,v.kind,
                r.unresolved_title,r.artist_hint,r.reference_url,r.revision,r.deleted_at
                FROM v_responses r LEFT JOIN v_participants p ON p.id=r.participant_id
                LEFT JOIN v_versions v ON v.id=r.version_id LEFT JOIN v_works w ON w.id=v.work_id
                WHERE r.deleted_at IS NULL''')
            self.connection.execute('''CREATE VIEW IF NOT EXISTS credit_details AS
                SELECT c.id AS credit_id,c.version_id,c.role,c.entity_id,e.name AS entity_name,
                c.source_id,c.confirmed,c.manual_lock FROM v_credits c
                LEFT JOIN v_entities e ON e.id=c.entity_id WHERE c.deleted_at IS NULL''')
            self.connection.execute('''CREATE VIEW IF NOT EXISTS tag_details AS
                SELECT a.id AS assignment_id,a.version_id,a.tag_id,t.name AS tag_name,t.category,
                a.evidence,a.source_id,a.origin,a.confirmed,a.manual_lock FROM v_tag_assignments a
                JOIN v_tags t ON t.id=a.tag_id WHERE a.deleted_at IS NULL AND t.deleted_at IS NULL AND t.active=1''')

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def close(self):
        self.connection.close()

    def meta(self, key):
        found = self.connection.execute('SELECT value FROM mirror_meta WHERE key=?', (key,)).fetchone()
        return found[0] if found else None

    def set_meta(self, key, value):
        self.connection.execute('INSERT INTO mirror_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, str(value)))

    @property
    def cursor(self):
        return int(self.meta('cursor'))

    @property
    def ack_cursor(self):
        return int(self.meta('ack_cursor'))

    def request_position(self):
        target = self.meta('target')
        return (int(self.meta('scan_cursor')), int(target)) if target is not None else (self.cursor, None)

    def accept(self, page):
        """Stage pages, then apply the entire frozen watermark in one transaction.

        The server has no transaction marker and can split related audit/row events
        across pages. Publishing only a complete watermark keeps the queryable
        mirror coherent even when transport dies between those pages.
        """
        cursor, target = self.request_position()
        if not isinstance(page, dict) or type(page.get('schema_version')) is not int or page['schema_version'] != 1:
            raise MirrorError('Feed schema mismatch; local data retained')
        watermark, next_cursor = page.get('high_watermark'), page.get('next_cursor')
        events, more = page.get('events'), page.get('has_more')
        if not integer(watermark) or not integer(next_cursor) or type(more) is not bool or not isinstance(events, list):
            raise MirrorError('Invalid feed page; local data retained')
        if watermark < cursor or (target is not None and watermark != target):
            raise MirrorError('Feed watermark changed or regressed; local data retained')
        previous = cursor
        for event in events:
            if not isinstance(event, dict) or not integer(event.get('sequence')) or not previous < event['sequence'] <= watermark:
                raise MirrorError('Invalid event sequence; local data retained')
            previous = event['sequence']
            row = event.get('row')
            if not isinstance(event.get('table'), str) or event['table'] not in COLUMNS or event.get('action') != 'upsert' or not isinstance(row, dict):
                raise MirrorError('Invalid business event; local data retained')
            if not isinstance(row.get('id'), str) or not row['id'] or row['id'] != event.get('row_id'):
                raise MirrorError('Invalid business row identity; local data retained')
            if not integer(row.get('revision')) or row['revision'] < 1 or any(key not in row for key in ['created_at', 'updated_at', 'deleted_at']):
                raise MirrorError('Invalid business row revision; local data retained')
            if not isinstance(event.get('occurred_at'), str):
                raise MirrorError('Invalid event timestamp; local data retained')
            # Feed already excludes credentials. Fail closed on accidental secret fields.
            if any(key in row for key in ['device_secret', 'invite_secret', 'token_hash', 'password_hash', 'sync_token', 'bearer']):
                raise MirrorError('Credential field in business feed; local data retained')
            try:
                encode(event)
            except (ValueError, TypeError):
                raise MirrorError('Non-JSON event; local data retained') from None
        if next_cursor > watermark or next_cursor < previous or (more and (not events or next_cursor != previous or previous >= watermark)) or (not more and next_cursor != watermark):
            raise MirrorError('Invalid feed cursor; local data retained')
        with self.connection:
            for event in events:
                self.connection.execute('INSERT INTO staged_events VALUES(?,?)', (event['sequence'], encode(event)))
            self.set_meta('target', watermark)
            self.set_meta('scan_cursor', next_cursor)
            if not more:
                for sequence, raw in self.connection.execute('SELECT sequence,event_json FROM staged_events ORDER BY sequence').fetchall():
                    event = json.loads(raw)
                    table, row = event['table'], event['row']
                    existing = self.connection.execute(f'SELECT revision FROM "{table}" WHERE id=?', (row['id'],)).fetchone()
                    if existing and existing[0] >= row['revision']:
                        raise MirrorError('Row revision regressed; local data retained')
                    self.connection.execute(f'INSERT INTO "{table}"(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', (row['id'], encode(row)))
                    self.connection.execute('INSERT INTO events VALUES(?,?)', (sequence, raw))
                self.set_meta('cursor', watermark)
                self.connection.execute('DELETE FROM staged_events')
                self.connection.execute("DELETE FROM mirror_meta WHERE key IN ('target','scan_cursor')")
        return not more

    def acknowledge(self, value, collector_id, cursor):
        if not isinstance(value, dict) or value.get('collector_id') != collector_id or not integer(value.get('schema_version')) or value['schema_version'] != 1 or not integer(value.get('cursor')) or value['cursor'] != cursor or not integer(cursor) or cursor > self.cursor or cursor < self.ack_cursor:
            raise MirrorError('Invalid acknowledgement; local checkpoint retained')
        with self.connection:
            self.set_meta('ack_cursor', cursor)
            self.set_meta('last_ack_at', datetime.now(timezone.utc).isoformat())

    def backup(self, folder, day=None):
        day = day or datetime.now(timezone(timedelta(hours=9))).date()
        folder = Path(folder).resolve()
        folder.mkdir(parents=True, exist_ok=True)
        output = folder / f'mirror-{day.isoformat()}.sqlite'
        if not output.exists():
            temporary = folder / f'.mirror-{day.isoformat()}-{os.getpid()}.tmp'
            try:
                with closing(sqlite3.connect(temporary)) as destination:
                    self.connection.backup(destination)
                    if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise MirrorError('Backup integrity check failed')
                os.replace(temporary, output)
            finally:
                temporary.unlink(missing_ok=True)
        files = sorted(p for p in folder.glob('mirror-*.sqlite') if re.fullmatch(r'mirror-\d{4}-\d{2}-\d{2}\.sqlite', p.name))
        for old in files[:-30]:
            old.unlink()
        return output


def validate_api(value, development=False):
    try:
        parsed = urllib.parse.urlsplit(value)
        host = parsed.hostname or ''
        cloud = parsed.scheme == 'https' and re.fullmatch(r'[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev', host) and parsed.port in (None, 443)
        local = development and parsed.scheme == 'http' and host == '127.0.0.1' and parsed.port is not None
        if not (cloud or local) or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != '/api/v1':
            raise ValueError()
    except (ValueError, TypeError):
        raise MirrorError('API must be a trusted HTTPS Workers URL ending /api/v1; loopback requires --development') from None
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Transport:
    def __init__(self, api, token, development=False):
        self.api = validate_api(api, development)
        if not isinstance(token, str) or not token or any(c.isspace() for c in token):
            raise MirrorError('Private sync bearer is missing or invalid')
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, body=None):
        request = urllib.request.Request(self.api + path,
            data=None if body is None else encode(body).encode('utf-8'),
            headers={'Authorization': 'Bearer ' + self.token,
                     'Content-Type': 'application/json', 'User-Agent': 'FavoriteSongSurvey-PCMirror/1.0'})
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise MirrorError('Feed response exceeded size limit')
                parsed = json.loads(raw)
                if not isinstance(parsed, dict) or 'data' not in parsed:
                    raise MirrorError('API response envelope invalid')
                return parsed['data']
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            raise MirrorError(f'HTTP {code}; credentials and response body redacted') from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise MirrorError('Network unavailable; local data retained') from None
        except (ValueError, UnicodeError):
            raise MirrorError('Invalid API JSON; local data retained') from None

    def feed(self, cursor, watermark):
        query = dict(cursor=cursor, schema_version=1, limit=200)
        if watermark is not None:
            query['high_watermark'] = watermark
        return self.request('/sync/feed?' + urllib.parse.urlencode(query))

    def ack(self, collector_id, cursor):
        return self.request('/sync/ack', dict(collector_id=collector_id, cursor=cursor, schema_version=1))


def drain(db, transport, max_pages=1000):
    for _ in range(max_pages):
        if db.accept(transport.feed(*db.request_position())):
            return db.cursor
    raise MirrorError('Page budget reached; staged data resumes next run')


def sync_once(db, transport, collector_id, backups):
    try:
        committed = drain(db, transport)
        # ACK itself adds sync_status + audit events. Drain one NEW frozen target,
        # deliberately without a second ACK, to avoid generating an infinite tail.
        db.acknowledge(transport.ack(collector_id, committed), collector_id, committed)
        drain(db, transport)
        return dict(cursor=db.cursor, acknowledged_cursor=db.ack_cursor)
    finally:
        # Also retain a coherent daily snapshot when the network or ACK fails.
        db.backup(backups)


def private_write(path, value):
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with open(temporary, 'w', encoding='utf-8') as output:
        os.chmod(temporary, 0o600)
        output.write(encode(value))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def load_config(path):
    config = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    validate_api(config['api_base'], config.get('development', False))
    for key in ['database', 'backups']:
        if not Path(config[key]).is_absolute():
            raise MirrorError('Collector database and backups require absolute paths')
    if not isinstance(config['collector_id'], str) or not 1 <= len(config['collector_id']) <= 80:
        raise MirrorError('Collector ID invalid')
    Transport(config['api_base'], config['sync_token'], config.get('development', False))
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['once', 'watch', 'configure'])
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--api-base')
    parser.add_argument('--database', type=Path)
    parser.add_argument('--backups', type=Path)
    parser.add_argument('--collector-id', default='windows-pc')
    parser.add_argument('--development', action='store_true')
    args = parser.parse_args()
    try:
        if args.command == 'configure':
            # The token never appears in command-line arguments or stdout.
            incoming = json.load(sys.stdin)
            config = dict(api_base=validate_api(args.api_base, args.development),
                          database=str(args.database.resolve()), backups=str(args.backups.resolve()),
                          collector_id=args.collector_id, sync_token=incoming['sync_token'], development=args.development)
            Transport(config['api_base'], config['sync_token'], args.development)
            private_write(args.config, config)
            print('Collector private config written')
            return 0
        config = load_config(args.config)
        # File lock prevents two scheduled/foreground runs from racing checkpoints.
        lock = Path(config['database'] + '.lock')
        lock.parent.mkdir(parents=True, exist_ok=True)
        with open(lock, 'a+b') as handle:
            handle.seek(0)
            handle.write(b'0')
            handle.flush()
            handle.seek(0)
            if os.name == 'nt':
                import msvcrt
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                except OSError:
                    raise MirrorError('Another collector run is active') from None
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            transport = Transport(config['api_base'], config['sync_token'], config.get('development', False))
            with Mirror(config['database']) as db:
                while True:
                    try:
                        result = sync_once(db, transport, config['collector_id'], config['backups'])
                        print(encode(result), flush=True)
                    except MirrorError as error:
                        if args.command == 'once':
                            raise
                        print(str(error), file=sys.stderr, flush=True)
                    if args.command == 'once':
                        break
                    time.sleep(300)
        return 0
    except MirrorError as error:
        print(str(error), file=sys.stderr)
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
        print('Collector configuration or database failure; private details redacted', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
