from pathlib import Path
import os
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
CHECK = ROOT / 'scripts' / 'setup-ci.mjs'


class CITests(unittest.TestCase):
    def test_public_build_url_gate_rejects_missing_localhost_userinfo_and_wrong_prefix(self):
        self.assertTrue(CHECK.exists(), 'production CI URL gate is missing')
        node = shutil.which('node')
        for value in ['', 'http://127.0.0.1:8791/api/v1', 'https://example.com/api/v1',
                      'https://song.user.workers.dev', 'https://secret@song.user.workers.dev/api/v1',
                      'https://song.user.workers.dev/api/v1?secret=x']:
            with self.subTest(value=value):
                env = dict(os.environ, VITE_API_BASE_URL=value)
                result = subprocess.run([node, str(CHECK)], env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('secret', result.stderr)
        result = subprocess.run([node, str(CHECK)], env=dict(os.environ,
            VITE_API_BASE_URL='https://favorite-song-survey-api.user.workers.dev/api/v1'),
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
