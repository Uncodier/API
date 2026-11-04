import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).with_name('deploy-foundation.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentTest(unittest.TestCase):
    def test_template_is_cpu_only_private_and_scales_to_zero(self):
        templates = []

        def fake_az(*args):
            if args[:2] == ('identity', 'create'):
                return {'id': '/test/identity', 'principalId': 'test-principal'}
            if args[:2] == ('acr', 'show'):
                return {'id': '/test/registry', 'loginServer': 'registry.example.invalid'}
            if args[:3] == ('acr', 'manifest', 'show-metadata'):
                return {'digest': 'sha256:test-image-digest'}
            if args[:4] == ('acr', 'config', 'authentication-as-arm', 'show'):
                return {'status': 'enabled'}
            if args[:3] == ('role', 'assignment', 'list'):
                return []
            if args[:2] == ('deployment', 'group'):
                template = json.loads(Path(args[args.index('--template-file') + 1]).read_text())
                templates.append(template)
                return {'properties': {'outputs': {'hostname': {'value': 'video.example.invalid'}}}}
            return {}

        with tempfile.TemporaryDirectory() as home:
            with patch.object(deploy.Path, 'home', return_value=Path(home)), \
                 patch.object(deploy, 'az', side_effect=fake_az), \
                 patch('sys.argv', ['deploy', '--subscription', 'test', '--registry', 'test']), \
                 patch('builtins.print'):
                deploy.main()
            credential = Path(home) / '.config/makinari/rg-makinari-video-video-token'
            self.assertEqual(credential.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(credential.read_text(), json.dumps(templates))
        self.assertEqual(len(templates), 2)
        resources = templates[0]['resources']
        app = next(r for r in resources if r['type'] == 'Microsoft.App/containerApps')
        scale = app['properties']['template']['scale']
        self.assertEqual((scale['minReplicas'], scale['maxReplicas']), (0, 1))
        self.assertFalse(any(r['type'].startswith(('Microsoft.Compute/', 'Microsoft.MachineLearningServices/'))
                             for r in resources))
        storage = next(r for r in resources if r['type'] == 'Microsoft.Storage/storageAccounts')
        self.assertFalse(storage['properties']['allowBlobPublicAccess'])
        self.assertFalse(storage['properties']['allowSharedKeyAccess'])
        self.assertEqual(templates[0]['parameters']['tokenHash']['type'], 'secureString')


if __name__ == '__main__':
    unittest.main()