"""Offline structural ARM/gating tests. These do not prove Azure deployment or inference."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
import uuid

spec = importlib.util.spec_from_file_location('gpu_deploy', Path(__file__).with_name('gpu-deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def config():
    subscription = str(uuid.uuid4())
    base = f'/subscriptions/{subscription}/resourceGroups/test/providers/'
    return SimpleNamespace(subscription=subscription, group='test', workspace='video-ml', compute='video-gpu',
        location='centralus', sku='Standard_NC96ads_A100_v4',
        storage_id=base + 'Microsoft.Storage/storageAccounts/testaccount',
        registry_id=base + 'Microsoft.ContainerRegistry/registries/testregistry',
        image='registry.example.test/worker@sha256:' + 'a' * 64,
        license_proof_ref='legal:approval/test', dispatcher_principal_id=str(uuid.uuid4()))


def quota():
    return {'value': [{'name': {'value': name}, 'unit': 'Count', 'currentValue': 0, 'limit': limit}
                      for name, limit in [('Standard NCads A100 v4 Family Cluster Dedicated vCPUs', 96),
                                          ('Total Cluster Dedicated Regional vCPUs', 96), ('Clusters', 1)]]}


class ProvisionTests(unittest.TestCase):
    def test_schema_and_bounded_compute(self):
        args = config()
        template = json.loads(json.dumps(deploy.build_template(args)))
        resources = template['resources']
        find = lambda suffix: next(r for r in resources if r['type'].endswith(suffix))
        compute = find('/computes')
        self.assertEqual(compute['properties']['computeType'], 'AmlCompute')
        self.assertEqual(compute['properties']['properties']['scaleSettings'],
                         {'minNodeCount': 0, 'maxNodeCount': 1, 'nodeIdleTimeBeforeScaleDown': 'PT120S'})
        self.assertEqual(compute['properties']['properties']['vmSize'], args.sku)
        self.assertEqual(compute['properties']['properties']['remoteLoginPortPublicAccess'], 'Disabled')
        self.assertTrue(compute['properties']['disableLocalAuth'])
        self.assertEqual(find('/workspaces')['properties']['storageAccount'], args.storage_id)
        self.assertEqual(find('/workspaces')['properties']['containerRegistry'], args.registry_id)
        self.assertTrue(find('/vaults')['properties']['enableRbacAuthorization'])
        self.assertEqual(find('/versions')['properties']['image'], args.image)
        self.assertEqual(find('/versions')['properties']['autoRebuild'], 'Disabled')
        self.assertFalse(any(r['type'].endswith('/jobs') for r in resources))
        self.assertNotIn('listKeys', json.dumps(template))
        self.assertNotIn('password', json.dumps(template))
        self.assertEqual(template, deploy.build_template(args))

    def test_rbac_scoped_and_dispatcher_no_compute_write(self):
        resources = deploy.build_template(config())['resources']
        roles = [r for r in resources if r['type'].endswith('/roleAssignments')]
        self.assertTrue(all('/providers/' in r['scope'] for r in roles))
        custom = next(r for r in resources if r['type'].endswith('/roleDefinitions'))
        actions = custom['properties']['permissions'][0]['actions']
        self.assertIn('Microsoft.MachineLearningServices/workspaces/jobs/write', actions)
        self.assertFalse(any('*' in action or 'computes/write' in action for action in actions))

    def test_input_gates(self):
        for field, value in [('image', 'registry.example.test/worker:latest'), ('license_proof_ref', ''),
                             ('subscription', '../bad'), ('sku', 'Standard_D2_v2')]:
            args = config()
            setattr(args, field, value)
            with self.assertRaises(ValueError):
                deploy.build_template(args)

    def run_quota(self, response):
        calls = []
        def call(*args):
            calls.append(args)
            if '/vmSizes?' in args[-1]:
                return {'value': [{'name': 'Standard_NC96ads_A100_v4', 'vCPUs': 96, 'gpus': 4,
                                  'family': 'standardNCadsA100v4Family', 'supportedComputeTypes': ['AmlCompute']}]}
            return response
        result = deploy.quota_preflight(config(), call)
        self.assertTrue(all(c[:3] == ('rest', '--method', 'get') for c in calls))
        return result

    def test_approved_quota_is_not_capacity_proof(self):
        result = self.run_quota(quota())
        self.assertTrue(result['quota_checked'])
        self.assertFalse(result['capacity_guaranteed'])

    def test_live_machine_readable_quota_and_duplicate_low_priority(self):
        q = quota()
        q['value'][0].update(name={'value': 'standardNCADSA100v4Family'},
            type='Microsoft.MachineLearningServices/vmFamily/dedicatedCores/usages')
        q['value'][1].update(name={'value': 'TotalDedicatedCores'},
            type='Microsoft.MachineLearningServices/totalDedicatedCores/usages', limit=350)
        q['value'][2].update(name={'value': 'TotalClusters'},
            type='Microsoft.MachineLearningServices/totalClusters/usages', limit=200)
        low = copy.deepcopy(q['value'][0])
        low.update(type='Microsoft.MachineLearningServices/vmFamily/lowPriorityCores/usages', limit=-1)
        q['value'].append(low)
        self.assertTrue(self.run_quota(q)['quota_checked'])
        q['value'][0]['limit'] = 0
        with self.assertRaises(ValueError):
            self.run_quota(q)

    def test_live_total_types_must_match(self):
        for index, name, wrong_type in [
            (1, 'TotalDedicatedCores', 'Microsoft.MachineLearningServices/dedicatedCores/usages'),
            (2, 'TotalClusters', 'Microsoft.MachineLearningServices/totalCores/usages'),
        ]:
            q = quota()
            q['value'][index].update(name={'value': name}, type=wrong_type)
            with self.assertRaises(ValueError):
                self.run_quota(q)

    def test_absent_exhausted_unknown_and_low_priority_quota_block(self):
        cases = [{'value': []}]
        for key, value in [('limit', 0), ('limit', -1), ('currentValue', 1), ('unit', 'Unknown')]:
            q = quota()
            q['value'][0][key] = value
            cases.append(q)
        q = quota()
        q['value'][0]['name']['value'] = q['value'][0]['name']['value'].replace('Dedicated', 'LowPriority')
        cases.append(q)
        for q in cases:
            with self.assertRaises(ValueError):
                self.run_quota(q)

    def test_no_mutations_when_blocked_even_with_apply(self):
        args = config()
        argv = ['--apply']
        for field in ['subscription', 'group', 'storage_id', 'registry_id', 'image', 'license_proof_ref', 'dispatcher_principal_id']:
            argv.extend(['--' + field.replace('_', '-'), getattr(args, field)])
        calls = []
        def call(*command):
            calls.append(command)
            return {'value': []}
        with self.assertRaises(ValueError):
            deploy.main(argv, call)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:3], ('rest', '--method', 'get'))


if __name__ == '__main__':
    unittest.main()