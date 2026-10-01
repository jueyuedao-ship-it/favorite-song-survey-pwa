import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / 'scripts' / 'install-collector.ps1'


class InstallerTests(unittest.TestCase):
    def test_plan_current_user_hidden_logon_and_five_minutes_without_registration(self):
        self.assertTrue(INSTALLER.exists(), 'scheduler installer is missing')
        powershell = shutil.which('powershell') or shutil.which('pwsh')
        with tempfile.TemporaryDirectory(dir=ROOT / 'collector' / 'tests') as directory:
            directory = Path(directory)
            config = directory / 'fixture-config.json'
            config.write_text(json.dumps(dict(api_base='http://127.0.0.1:8791/api/v1', sync_token='fixture-token',
                development=True, database=str(directory / 'mirror.sqlite'), backups=str(directory / 'backups'), collector_id='pc-fixture')))
            result = subprocess.run([powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(INSTALLER),
                                     '-ConfigPath', str(config), '-PlanOnly'], capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertNotIn('fixture-token', result.stdout)
            xml = ET.fromstring(plan['xml'])
            ns = {'s':'http://schemas.microsoft.com/windows/2004/02/mit/task'}
            self.assertEqual(xml.find('.//s:LogonType', ns).text, 'InteractiveToken')
            self.assertEqual(xml.find('.//s:RunLevel', ns).text, 'LeastPrivilege')
            self.assertEqual(xml.find('.//s:Repetition/s:Interval', ns).text, 'PT5M')
            self.assertIsNotNone(xml.find('.//s:LogonTrigger', ns))
            self.assertEqual(xml.find('.//s:Hidden', ns).text, 'true')
            self.assertIn('-WindowStyle Hidden', xml.find('.//s:Arguments', ns).text)
            self.assertEqual(plan['registered'], False)

    def test_rejects_config_outside_workspace_before_registration(self):
        self.assertTrue(INSTALLER.exists(), 'scheduler installer is missing')
        powershell = shutil.which('powershell') or shutil.which('pwsh')
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'outside.json'
            config.write_text('{}')
            result = subprocess.run([powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(INSTALLER),
                                     '-ConfigPath', str(config), '-PlanOnly'], capture_output=True, text=True, encoding='utf-8')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('outside intended workspace', result.stderr)


if __name__ == '__main__':
    unittest.main()
