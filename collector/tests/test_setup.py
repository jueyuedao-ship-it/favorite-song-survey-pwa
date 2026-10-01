import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys

SETUP_PATH = Path(__file__).resolve().parents[2] / 'scripts' / 'setup-private.py'
setup = None
if SETUP_PATH.exists():
    spec = importlib.util.spec_from_file_location('private_setup', SETUP_PATH)
    setup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(setup, 'private setup tooling is missing')

    def test_verifier_matches_frozen_worker_format_and_never_contains_password(self):
        verifier = setup.password_verifier('人が選んだfixture専用')
        self.assertRegex(verifier, r'^pbkdf2\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$')
        _, iterations, salt, digest = verifier.split('$')
        self.assertEqual(digest, hashlib.pbkdf2_hmac('sha256', '人が選んだfixture専用'.encode(), bytes.fromhex(salt), int(iterations)).hex())
        self.assertNotEqual(verifier, setup.password_verifier('人が選んだfixture専用'))

    def test_only_known_development_fixture_passwords_are_rejected(self):
        for password in ['integration-password', 'local-verification-only-2026']:
            with self.subTest(password=password):
                with self.assertRaises(setup.SetupError):
                    setup.password_verifier(password)
        for password in ['admin', 'password', 'demo']:
            self.assertRegex(setup.password_verifier(password), '^pbkdf2')

    def test_cloud_flow_mutates_only_new_project_and_keeps_secret_values_off_argv(self):
        account = 'a' * 32
        database = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
        calls = []
        class Cloud:
            def request(self, path, method='GET', body=None):
                calls.append((method, path, body))
                if path.endswith('/subscriptions'):
                    return []
                if '/d1/database?' in path or path.endswith('/workers/scripts'):
                    return []
                if path.endswith('/d1/database'):
                    return dict(uuid=database)
                if path.endswith('/workers/subdomain'):
                    return dict(subdomain='fixture')
                raise AssertionError('Unexpected endpoint')
        class Runner:
            def wr(self, *args, stdin=None):
                calls.append(('CLI', args, stdin))
                return ''
        login_passwords = []
        def api(api, path, body=None):
            if path == '/health':
                return 200, dict(data=dict(configured=dict(admin=True,sync=True,groq=True,tavily=True,research_runner=True)))
            login_passwords.append(body['password'])
            return (200, dict(data=dict(session_token='fixture-admin-session'))) if len(login_passwords) == 1 else (401, None)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.local').mkdir()
            (root / '.local' / 'setup.json').write_text(json.dumps(dict(admin_password='fixture-human-password', groq_api_key='fixture-groq',tavily_api_key='fixture-tavily')))
            with patch.object(setup, 'cloud_context', return_value=(account, Cloud())), patch.object(setup, 'api_request', side_effect=api):
                result = setup.cloud_setup(root, Runner())
            self.assertTrue(result['admin_login_verified'])
            self.assertEqual(login_passwords, ['fixture-human-password', 'local-verification-only-2026', 'integration-password'])
            mutations = [(method, path) for method,path,body in calls if method == 'POST']
            self.assertEqual(mutations, [('POST', '/accounts/' + account + '/d1/database')])
            cli = [call for call in calls if call[0] == 'CLI']
            self.assertEqual([call[1][:2] for call in cli], [('d1','migrations'),('deploy','--config'),('secret','bulk')])
            self.assertNotIn('fixture-groq', str([call[1] for call in cli]))
            self.assertNotIn('fixture-human-password', str([call[1] for call in cli]))
            self.assertIn('SYNC_TOKEN_HASH', json.loads(cli[-1][2]))
            state = json.loads((root / '.local' / 'cloud-state.json').read_text())
            self.assertEqual(state['database_id'], database)
            self.assertEqual(state['api_base'], 'https://favorite-song-survey-api.fixture.workers.dev/api/v1')

    def test_cli_failure_redacts_captured_stdout_stderr(self):
        runner = object.__new__(setup.Runner)
        with tempfile.TemporaryDirectory() as directory:
            runner.root = Path(directory)
            with self.assertRaises(setup.SetupError) as caught:
                runner.run(sys.executable, ['-c', 'import sys; print("fixture-sensitive"); print("fixture-sensitive", file=sys.stderr); sys.exit(1)'])
            self.assertNotIn('fixture-sensitive', str(caught.exception))

    def test_secret_preparation_retains_token_across_retry_and_only_uploads_verifier(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private = root / '.local'
            private.mkdir()
            (private / 'setup.json').write_text(json.dumps(dict(admin_password='not-a-real-password',
                groq_api_key='fixture-groq', tavily_api_key='fixture-tavily')))
            secrets, token = setup.prepare_secrets(root)
            self.assertEqual(secrets['GROQ_API_KEY'], 'fixture-groq')
            self.assertEqual(secrets['SYNC_TOKEN_HASH'], hashlib.sha256(token.encode()).hexdigest())
            self.assertNotIn(token, json.dumps(secrets))
            self.assertNotIn('not-a-real-password', json.dumps(secrets))
            again, token_again = setup.prepare_secrets(root)
            self.assertEqual(token_again, token)
            self.assertEqual(again, secrets)

    def test_paid_workers_plan_is_rejected_and_unknown_is_not_assumed_free(self):
        self.assertEqual(setup.classify_workers_plan([]), 'free')
        self.assertEqual(setup.classify_workers_plan([{'rate_plan': {'id':'workers_free','public_name':'Workers Free'}}]), 'free')
        self.assertEqual(setup.classify_workers_plan([{'rate_plan': {'id':'workers_paid','public_name':'Workers Paid'}}]), 'paid')
        self.assertEqual(setup.classify_workers_plan([{'rate_plan': {'id':'workers_standard','public_name':'Workers Standard'}}]), 'paid')
        self.assertEqual(setup.classify_workers_plan([{'rate_plan': {'id':'workers_free','public_name':'Workers Paid'}}]), 'paid')
        self.assertEqual(setup.classify_workers_plan(['malformed']), 'unknown')
        self.assertEqual(setup.classify_workers_plan({'not':'a list'}), 'unknown')

    def test_incomplete_plan_metadata_is_unknown_and_paid_dominates_every_order(self):
        paid = {'rate_plan': {'id':'workers_paid', 'public_name':'Workers Paid'}}
        incomplete = [{}, {'rate_plan': {}}, {'rate_plan': {'id':'','public_name':' '}},
                      {'rate_plan': {'id':42}}, {'rate_plan': None}, 'malformed']
        for bad in incomplete:
            with self.subTest(bad=bad):
                self.assertEqual(setup.classify_workers_plan([bad]), 'unknown')
                self.assertEqual(setup.classify_workers_plan([bad, paid]), 'paid')
                self.assertEqual(setup.classify_workers_plan([paid, bad]), 'paid')

    def test_confirmation_flag_cannot_override_detected_paid_workers_or_mutate_resources(self):
        for confirm in [False, True]:
            with self.subTest(confirm=confirm), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / '.local').mkdir()
                (root / '.local' / 'setup.json').write_text(json.dumps(dict(admin_password='fixture-human',
                    groq_api_key='fixture-groq', tavily_api_key='fixture-tavily')))
                calls = []
                class Cloud:
                    def request(self, path, method='GET', body=None):
                        calls.append((method,path))
                        if path.endswith('/subscriptions'):
                            return ['malformed', {'rate_plan': {'id':'workers_paid','public_name':'Workers Paid'}}]
                        if '/d1/database?' in path or path.endswith('/workers/scripts'):
                            return []
                        raise AssertionError('Unexpected mutation')
                class Runner:
                    def wr(self, *args, **kwargs):
                        raise AssertionError('Wrangler mutation must not be reached')
                with patch.object(setup, 'cloud_context', return_value=('a'*32, Cloud())):
                    with self.assertRaises(setup.SetupError):
                        setup.cloud_setup(root, Runner(), confirm_free=confirm)
                self.assertEqual(calls, [('GET', '/accounts/' + 'a'*32 + '/subscriptions')])
                self.assertEqual(sorted(p.name for p in (root / '.local').iterdir()), ['setup.json'])

    def test_existing_unrelated_resources_rejected_before_creation_or_deploy(self):
        with self.assertRaises(setup.SetupError):
            setup.verify_resource_ownership([{'name':'favorite-song-survey', 'uuid':'unrelated'}], [], None)
        with self.assertRaises(setup.SetupError):
            setup.verify_resource_ownership([], [{'id':'favorite-song-survey-api'}], None)
        state = dict(project='favorite-song-survey', database_id='owned', worker_name='favorite-song-survey-api')
        self.assertEqual(setup.verify_resource_ownership([{'name':'favorite-song-survey','uuid':'owned'}], [{'id':'favorite-song-survey-api'}], state), 'owned')

    def test_production_config_has_only_public_fields_real_id_safe_origin_and_minute_cron(self):
        with tempfile.TemporaryDirectory() as directory:
            config = setup.production_config(Path(directory), 'a' * 32, 'b' * 8 + '-bbbb-bbbb-bbbb-' + 'b' * 12)
        self.assertEqual(config['triggers']['crons'], ['* * * * *'])
        self.assertEqual(config['vars']['ALLOWED_ORIGINS'], 'https://jueyuedao-ship-it.github.io')
        self.assertNotIn('localhost', json.dumps(config))
        self.assertNotIn('GROQ_API_KEY', config['vars'])
        self.assertEqual(config['d1_databases'][0]['binding'], 'DB')

    def test_github_validation_requires_expected_repo_readme_and_html(self):
        encode = lambda text: dict(content=base64.b64encode(text.encode()).decode())
        setup.verify_github_project(dict(name='favorite-song-survey-pwa', owner={'login':'jueyuedao-ship-it'}),
                                    encode('# 好きな曲アンケート / favorite-song-survey-pwa'), encode('<title>好きな曲アンケート</title>'))
        for repo, readme, html in [
            (dict(name='other', owner={'login':'jueyuedao-ship-it'}), encode('favorite-song-survey-pwa'), encode('好きな曲アンケート')),
            (dict(name='favorite-song-survey-pwa', owner={'login':'jueyuedao-ship-it'}), encode('unrelated app'), encode('好きな曲アンケート')),
            (dict(name='favorite-song-survey-pwa', owner={'login':'jueyuedao-ship-it'}), encode('favorite-song-survey-pwa'), encode('other app')),
        ]:
            with self.assertRaises(setup.SetupError):
                setup.verify_github_project(repo, readme, html)


if __name__ == '__main__':
    unittest.main()
