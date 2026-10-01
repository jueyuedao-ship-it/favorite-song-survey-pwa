"""Private deployment entry point. Never prints credentials or subprocess output."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'collector'))
from mirror import MirrorError, NoRedirect, private_write, validate_api

PROJECT = 'favorite-song-survey'
WORKER = 'favorite-song-survey-api'
OWNER = 'jueyuedao-ship-it'
REPO = OWNER + '/favorite-song-survey-pwa'
ROOT = Path(__file__).resolve().parents[1]
DEVELOPMENT_FIXTURES = ['local-verification-only-2026', 'integration-password']


class SetupError(Exception):
    pass


def password_verifier(password):
    if not isinstance(password, str) or not 1 <= len(password) <= 1024:
        raise SetupError('Admin password missing or invalid')
    if password in DEVELOPMENT_FIXTURES:
        raise SetupError('Production cannot use a known demo password')
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000)
    return f'pbkdf2$100000${salt.hex()}${digest.hex()}'


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def tavily_key(values):
    token = values.get('tavily_api_key') or os.environ.get('TAVILY_API_KEY')
    if not token and os.name == 'nt':
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as key:
                token = winreg.QueryValueEx(key, 'TAVILY_API_KEY')[0]
        except OSError:
            pass
    return token


def setup_values(root):
    values = read_json(root / '.local' / 'setup.json')
    values['tavily_api_key'] = tavily_key(values)
    for key in ['admin_password', 'groq_api_key', 'tavily_api_key']:
        if not isinstance(values.get(key), str) or not values[key].strip():
            raise SetupError('Private setup is missing a required field (values redacted)')
    return values


def prepare_secrets(root):
    values = setup_values(root)
    # Verifier and sync bearer are stable across interrupted provisioning/retry.
    path = root / '.local' / 'credentials.json'
    if path.exists():
        credentials = read_json(path)
        verifier, token = credentials['admin_verifier'], credentials['sync_token']
        _, iterations, salt, digest = verifier.split('$')
        if hashlib.pbkdf2_hmac('sha256', values['admin_password'].encode(), bytes.fromhex(salt), int(iterations)).hex() != digest:
            raise SetupError('Admin password changed; explicitly rotate credentials before redeployment')
    else:
        verifier, token = password_verifier(values['admin_password']), secrets.token_urlsafe(48)
        private_write(path, dict(admin_verifier=verifier, sync_token=token))
    output = dict(ADMIN_PASSWORD_HASH=verifier, SYNC_TOKEN_HASH=hashlib.sha256(token.encode()).hexdigest(),
                  GROQ_API_KEY=values['groq_api_key'], TAVILY_API_KEY=values['tavily_api_key'])
    private_write(root / '.local' / 'worker-secrets.json', output)
    return output, token


def classify_workers_plan(subscriptions):
    if not isinstance(subscriptions, list):
        return 'unknown'
    # Only the complete successful subscriptions result is passed here. An empty
    # list means the account has no subscriptions (including Workers Paid), so
    # the Workers default is Free. Missing/malformed rows are NOT an empty list.
    unknown, paid = False, False
    for subscription in subscriptions:
        if not isinstance(subscription, dict):
            unknown = True
            continue
        plan = subscription.get('rate_plan')
        if not isinstance(plan, dict):
            unknown = True
            continue
        labels = []
        for key in ['id', 'public_name']:
            if key in plan:
                if isinstance(plan[key], str) and plan[key].strip():
                    labels.append(plan[key].strip().lower())
                else:
                    unknown = True
        if not labels:
            unknown = True
            continue
        label = ' '.join(labels)
        if 'worker' in label and ('free' not in label or any(word in label for word in ['paid', 'standard', 'bundled', 'unbound', 'enterprise'])):
            paid = True
    # Scan all entries: Paid must dominate unknown regardless of entry order.
    return 'paid' if paid else 'unknown' if unknown else 'free'


def verify_resource_ownership(databases, workers, state):
    dbs = [db for db in databases if db.get('name') == PROJECT]
    scripts = [worker for worker in workers if worker.get('id') == WORKER]
    if len(dbs) > 1:
        raise SetupError('Ambiguous existing project database; no resources changed')
    owned = isinstance(state, dict) and state.get('project') == PROJECT and state.get('worker_name') == WORKER
    if dbs and (not owned or dbs[0].get('uuid') != state.get('database_id')):
        raise SetupError('Existing database not proven owned by this project; no resources changed')
    if scripts and not owned:
        raise SetupError('Existing Worker not proven owned by this project; no resources changed')
    if owned and state.get('database_id') and not dbs:
        raise SetupError('Previously created project database missing; investigate before creating another')
    return dbs[0]['uuid'] if dbs else None


def production_config(root, account, database):
    if not re.fullmatch('[a-f0-9]{32}', account) or not re.fullmatch('[a-f0-9-]{36}', database) or database == '00000000-0000-0000-0000-000000000000':
        raise SetupError('Production account/database identity invalid')
    return dict(name=WORKER, main=str(root / 'worker' / 'src' / 'index.ts'),
                compatibility_date='2026-07-30', workers_dev=True, account_id=account,
                vars=dict(GROQ_MODEL='qwen/qwen3.8-27b', ALLOWED_ORIGINS='https://' + OWNER + '.github.io'),
                d1_databases=[dict(binding='DB', database_name=PROJECT, database_id=database,
                                  migrations_dir=str(root / 'worker' / 'schema'))],
                triggers=dict(crons=['* * * * *']))


def verify_github_project(repo, readme, html):
    if repo.get('name') != 'favorite-song-survey-pwa' or repo.get('owner', {}).get('login') != OWNER:
        raise SetupError('Unexpected GitHub repository identity; no GitHub mutation')
    try:
        readme = base64.b64decode(readme['content']).decode('utf-8')
        html = base64.b64decode(html['content']).decode('utf-8')
    except (ValueError, KeyError, UnicodeError):
        raise SetupError('GitHub project files could not be verified') from None
    if 'favorite-song-survey-pwa' not in readme or '好きな曲アンケート' not in html:
        raise SetupError('README/main HTML do not identify this project; no GitHub mutation')


class Runner:
    def __init__(self, root):
        self.root = root
        self.node = shutil.which('node')
        if not self.node:
            raise SetupError('Node.js unavailable')
        self.wrangler = root / 'node_modules' / 'wrangler' / 'bin' / 'wrangler.js'
        if not self.wrangler.is_file():
            raise SetupError('Install locked project dependencies before setup')

    def run(self, executable, args, stdin=None):
        env = os.environ.copy()
        env.update(WRANGLER_WRITE_LOGS='false', WRANGLER_SEND_METRICS='false', WRANGLER_LOG='log', CI='true')
        # Never use shell=True, print args, or inherit stdout/stderr from private CLIs.
        try:
            result = subprocess.run([executable, *args], input=stdin, capture_output=True,
                                    text=True, encoding='utf-8', cwd=self.root, env=env, timeout=300)
        except (OSError, subprocess.TimeoutExpired):
            raise SetupError('Setup CLI unavailable or timed out (private details redacted)') from None
        if result.returncode:
            raise SetupError('Setup CLI failed (private stdout/stderr redacted); inspect authentication or resource rights')
        return result.stdout

    def wr(self, *args, stdin=None):
        return self.run(self.node, [str(self.wrangler), *args], stdin)

    def gh(self, *args, stdin=None):
        executable = shutil.which('gh')
        if not executable:
            raise SetupError('GitHub CLI unavailable')
        return self.run(executable, list(args), stdin)


class Cloudflare:
    def __init__(self, runner):
        auth = json.loads(runner.wr('auth', 'token', '--json'))
        if auth.get('type') not in ['oauth', 'api_token'] or not auth.get('token'):
            raise SetupError('Cloudflare OAuth/API token unavailable')
        self.token = auth['token']
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, method='GET', body=None):
        # Internal callers use fixed resource paths. No subscription writes exist.
        if method != 'GET' and not (method == 'POST' and re.fullmatch(r'/accounts/[a-f0-9]{32}/d1/database', path)):
            raise SetupError('Cloudflare mutation outside approved new-D1 creation refused')
        request = urllib.request.Request('https://api.cloudflare.com/client/v4' + path, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization':'Bearer ' + self.token, 'Content-Type':'application/json',
                     'User-Agent':'FavoriteSongSurvey-PrivateSetup/1.0'})
        try:
            with self.opener.open(request, timeout=30) as response:
                result = json.loads(response.read(2 * 1024 * 1024))
            if not result.get('success'):
                raise SetupError('Cloudflare API refused operation (private response redacted)')
            return result['result']
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            raise SetupError(f'Cloudflare HTTP {code} (private response redacted)') from None
        except (urllib.error.URLError, OSError, ValueError, KeyError):
            raise SetupError('Cloudflare transport failed (private details redacted)') from None


def cloud_context(root, runner):
    who = json.loads(runner.wr('whoami', '--json'))
    accounts = who.get('accounts', [])
    if not who.get('loggedIn') or len(accounts) != 1:
        raise SetupError('Exactly one authenticated Cloudflare account is required')
    account = accounts[0]['id']
    if not re.fullmatch('[a-f0-9]{32}', account):
        raise SetupError('Cloudflare account invalid')
    metadata_path = root / '.local' / 'cloudflare-account.json'
    if metadata_path.exists():
        metadata = read_json(metadata_path)
        expected = metadata.get('account_id') or metadata.get('id')
        if expected and expected != account:
            raise SetupError('Authenticated account differs from local project preflight')
    return account, Cloudflare(runner)


def workers_plan(cloud, account):
    try:
        return classify_workers_plan(cloud.request('/accounts/' + account + '/subscriptions'))
    except SetupError:
        return 'unknown'


def check(root, runner):
    values = setup_values(root)
    account, cloud = cloud_context(root, runner)
    databases = cloud.request('/accounts/' + account + '/d1/database?per_page=100')
    workers = cloud.request('/accounts/' + account + '/workers/scripts')
    return dict(private_setup_complete=True, cloudflare_authenticated=True,
                workers_plan=workers_plan(cloud, account),
                project_database_exists=any(db.get('name') == PROJECT for db in databases),
                project_worker_exists=any(worker.get('id') == WORKER for worker in workers),
                collector_configured=(root / '.local' / 'collector.json').is_file())


def api_request(api, path, body=None):
    validate_api(api)
    request = urllib.request.Request(api + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type':'application/json', 'User-Agent':'FavoriteSongSurvey-SetupAcceptance/1.0'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
            return response.status, json.loads(response.read(65536))
    except urllib.error.HTTPError as error:
        # No body reads/logs on failure, including login failures.
        code = error.code
        error.close()
        return code, None
    except (urllib.error.URLError, OSError, ValueError):
        raise SetupError('Production API acceptance request failed (private details redacted)') from None


def cloud_setup(root, runner, confirm_free=False):
    values = setup_values(root)
    account, cloud = cloud_context(root, runner)
    plan = workers_plan(cloud, account)
    if plan == 'paid' or (plan != 'free' and not confirm_free):
        raise SetupError('Workers Free plan not verified; no cloud changes. If read scope unavailable, verify dashboard and use --confirm-workers-free')
    state_path = root / '.local' / 'cloud-state.json'
    state = read_json(state_path) if state_path.exists() else None
    if state and (state.get('account_id') != account or state.get('workspace') != str(root.resolve())):
        raise SetupError('Project ownership state belongs to another account/workspace')
    databases = cloud.request('/accounts/' + account + '/d1/database?per_page=100')
    workers = cloud.request('/accounts/' + account + '/workers/scripts')
    database = verify_resource_ownership(databases, workers, state)
    secrets_payload, _ = prepare_secrets(root)
    if not database:
        created = cloud.request('/accounts/' + account + '/d1/database', 'POST', dict(name=PROJECT))
        database = created['uuid']
        state = dict(project=PROJECT, worker_name=WORKER, database_id=database,
                     account_id=account, workspace=str(root.resolve()))
        # Persist ownership immediately, before a migration/deploy can fail.
        private_write(state_path, state)
    config = root / '.local' / 'wrangler.production.json'
    private_write(config, production_config(root, account, database))
    runner.wr('d1', 'migrations', 'apply', PROJECT, '--remote', '--config', str(config))
    runner.wr('deploy', '--config', str(config))
    runner.wr('secret', 'bulk', '--config', str(config), stdin=json.dumps(secrets_payload))
    subdomain = cloud.request('/accounts/' + account + '/workers/subdomain')['subdomain']
    api = validate_api('https://' + WORKER + '.' + subdomain + '.workers.dev/api/v1')
    # Retry deployment propagation only; never retry invalid credentials indefinitely.
    for attempt in range(6):
        status, health = api_request(api, '/health')
        if status == 200 and health and all(health.get('data', {}).get('configured', {}).get(k) for k in ['admin','sync','groq','tavily','research_runner']):
            break
        if attempt == 5:
            raise SetupError('Production health flags incomplete after deployment')
        time.sleep(5)
    status, login = api_request(api, '/admin/login', dict(password=values['admin_password']))
    if status != 200 or not login or not login.get('data', {}).get('session_token'):
        raise SetupError('Production chosen-password login failed')
    # Public test credential always rejected; optional private fixture allows exact local rejection.
    fixtures = list(DEVELOPMENT_FIXTURES)
    if values.get('fixture_password_to_reject'):
        fixtures.append(values['fixture_password_to_reject'])
    for fixture in dict.fromkeys(fixtures):
        if fixture == values['admin_password']:
            raise SetupError('Production and local fixture passwords must differ')
        status, _ = api_request(api, '/admin/login', dict(password=fixture))
        if status != 401:
            raise SetupError('Production accepted local/demo fixture password or rejection unverified')
    state.update(api_base=api, verified=True)
    private_write(state_path, state)
    return dict(cloud_ready=True, api_base=api, admin_login_verified=True, fixture_rejected=True,
                workers_plan='free' if plan == 'free' else 'dashboard-confirmed-free')


def collector_setup(root):
    state = read_json(root / '.local' / 'cloud-state.json')
    if not state.get('verified'):
        raise SetupError('Verify production health/login before configuring collector')
    credentials = read_json(root / '.local' / 'credentials.json')
    config = dict(api_base=validate_api(state['api_base']), sync_token=credentials['sync_token'],
                  collector_id='windows-' + hashlib.sha256(str(root).encode()).hexdigest()[:12],
                  database=str((root / 'data' / 'mirror.sqlite').resolve()),
                  backups=str((root / 'backups').resolve()), development=False)
    private_write(root / '.local' / 'collector.json', config)
    return dict(collector_configured=True, scheduled_task_installed=False)


def github_setup(root, runner):
    state = read_json(root / '.local' / 'cloud-state.json')
    if not state.get('verified'):
        raise SetupError('Production API must be verified before CI variable update')
    repo = json.loads(runner.gh('api', 'repos/' + REPO))
    readme = json.loads(runner.gh('api', 'repos/' + REPO + '/contents/README.md?ref=main'))
    html = json.loads(runner.gh('api', 'repos/' + REPO + '/contents/web/index.html?ref=main'))
    verify_github_project(repo, readme, html)
    api = validate_api(state['api_base'])
    runner.gh('variable', 'set', 'VITE_API_BASE_URL', '--repo', REPO, stdin=api)
    return dict(github_public_api_variable_set=True, api_base=api)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check', 'cloud', 'collector', 'github'])
    parser.add_argument('--confirm-workers-free', action='store_true',
                        help='Only after verifying Workers Free in dashboard when subscription read scope is unavailable')
    args = parser.parse_args()
    try:
        if args.command == 'collector':
            result = collector_setup(ROOT)
        else:
            runner = Runner(ROOT)
            if args.command == 'check':
                result = check(ROOT, runner)
            elif args.command == 'cloud':
                result = cloud_setup(ROOT, runner, args.confirm_workers_free)
            else:
                result = github_setup(ROOT, runner)
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except (SetupError, MirrorError) as error:
        print(str(error), file=sys.stderr)
    except (OSError, ValueError, TypeError, KeyError):
        print('Private setup metadata invalid; values and raw errors redacted', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
