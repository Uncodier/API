#!/usr/bin/env python3
"""Deploy the disabled CPU foundation only. Never provisions GPU or downloads weights."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import subprocess
import tempfile


def az(*args):
    result = subprocess.run(
        ['az', *args, '--only-show-errors', '--output', 'json'],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout) if result.stdout.strip() else None


def resource(resource_type, name, properties, version='2023-05-01', **extra):
    return {'type': resource_type, 'apiVersion': version, 'name': name, 'properties': properties, **extra}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--subscription', required=True)
    parser.add_argument('--location', default='centralus')
    parser.add_argument('--group', default='rg-makinari-video')
    parser.add_argument('--registry', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    # Write raw credentials outside the repository, never to logs or CLI arguments.
    credentials = Path.home() / '.config' / 'makinari' / f'{args.group}-video-token'
    credentials.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not credentials.exists():
        fd = os.open(credentials, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(secrets.token_hex(32))
    if credentials.stat().st_mode & 0o077:
        raise RuntimeError('Credential file must not be accessible to group or other users')
    token = credentials.read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise RuntimeError('Invalid local credential file')
    digest = hashlib.sha256(token.encode()).hexdigest()
    subscription = args.subscription
    suffix = hashlib.sha256(f'{subscription}:{args.group}'.encode()).hexdigest()[:10]
    storage = f'mkvideo{suffix}'
    app = 'makinari-video'
    environment = 'makinari-video-env'
    identity_name = 'makinari-video-identity'
    tags = {'application': 'makinari-video', 'stage': 'foundation-blocked', 'gpu': 'disabled'}
    registry = az('acr', 'show', '--subscription', subscription, '--name', args.registry)
    if registry.get('roleAssignmentMode') not in (None, 'LegacyRegistryPermissions'):
        raise RuntimeError('Registry requires ABAC repository permissions; shared registry was not modified')
    registry_auth = az('acr', 'config', 'authentication-as-arm', 'show',
                       '--subscription', subscription, '--registry', args.registry)
    if registry_auth.get('status') != 'enabled':
        raise RuntimeError('Registry ARM authentication must be enabled for managed identity pulls')
    az('group', 'create', '--subscription', subscription, '--name', args.group,
       '--location', args.location, '--tags', *[f'{k}={v}' for k, v in tags.items()])
    identity = az('identity', 'create', '--subscription', subscription,
                  '--resource-group', args.group, '--name', identity_name, '--location', args.location)
    # Pull-only grant on the pre-existing registry; do not change its configuration.
    assignments = az('role', 'assignment', 'list', '--subscription', subscription,
                     '--scope', registry['id'])
    role_id = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    if not any(a['principalId'] == identity['principalId']
               and a['roleDefinitionId'].endswith(role_id) for a in assignments):
        az('role', 'assignment', 'create', '--subscription', subscription,
           '--assignee-object-id', identity['principalId'], '--assignee-principal-type', 'ServicePrincipal',
           '--role', role_id, '--scope', registry['id'])
    image_tag = hashlib.sha256(b''.join((root / file).read_bytes() for file in
        ['server.mjs', 'jobs.mjs', 'azure-store.mjs', 'dispatcher.mjs', 'Dockerfile'])).hexdigest()[:16]
    image = f'{registry["loginServer"]}/makinari-video/foundation:{image_tag}'
    print('Building isolated CPU image in Azure Container Registry...', flush=True)
    az('acr', 'build', '--subscription', subscription, '--registry', args.registry,
       '--image', f'makinari-video/foundation:{image_tag}', '--no-logs', str(root))
    manifest = az('acr', 'manifest', 'show-metadata', '--subscription', subscription,
                  '--registry', args.registry, '--name', f'makinari-video/foundation:{image_tag}')
    image = f'{registry["loginServer"]}/makinari-video/foundation@{manifest["digest"]}'
    prefix = f'/subscriptions/{subscription}/resourceGroups/{args.group}/providers/'
    environment_id = prefix + 'Microsoft.App/managedEnvironments/' + environment
    storage_id = prefix + 'Microsoft.Storage/storageAccounts/' + storage
    resources = [
        resource('Microsoft.App/managedEnvironments', environment, {
            'workloadProfiles': [{'name': 'Consumption', 'workloadProfileType': 'Consumption'}],
        }, '2024-03-01', location=args.location, tags=tags),
        resource('Microsoft.Storage/storageAccounts', storage, {
            'minimumTlsVersion': 'TLS1_2', 'supportsHttpsTrafficOnly': True,
            'allowBlobPublicAccess': False, 'allowSharedKeyAccess': False,
            'defaultToOAuthAuthentication': True,
        }, location=args.location, kind='StorageV2', sku={'name': 'Standard_LRS'}, tags=tags),
        resource('Microsoft.Storage/storageAccounts/blobServices', storage + '/default', {},
                 dependsOn=[storage_id]),
        resource('Microsoft.Storage/storageAccounts/blobServices/containers', storage + '/default/videos',
                 {'publicAccess': 'None'}, dependsOn=[storage_id + '/blobServices/default']),
        resource('Microsoft.Storage/storageAccounts/blobServices/containers', storage + '/default/jobs',
                 {'publicAccess': 'None'}, dependsOn=[storage_id + '/blobServices/default']),
        resource('Microsoft.Storage/storageAccounts/queueServices', storage + '/default', {},
                 dependsOn=[storage_id]),
        resource('Microsoft.Storage/storageAccounts/queueServices/queues', storage + '/default/video-jobs', {},
                 dependsOn=[storage_id + '/queueServices/default']),
        resource('Microsoft.Storage/storageAccounts/managementPolicies', storage + '/default', {
            'policy': {'rules': [{'enabled': True, 'name': 'expire-videos-after-seven-days', 'type': 'Lifecycle',
                'definition': {'filters': {'blobTypes': ['blockBlob'], 'prefixMatch': ['videos/']},
                               'actions': {'baseBlob': {'delete': {'daysAfterModificationGreaterThan': 7}}}}}]},
        }, dependsOn=[storage_id]),
        resource('Microsoft.App/containerApps', app, {
            'managedEnvironmentId': environment_id,
            'workloadProfileName': 'Consumption',
            'configuration': {
                'activeRevisionsMode': 'Single',
                'secrets': [{'name': 'video-api-token-sha256', 'value': '[parameters(\'tokenHash\')]'}],
                'registries': [{'server': registry['loginServer'], 'identity': identity['id']}],
                'ingress': {'external': True, 'targetPort': 8080, 'transport': 'http', 'allowInsecure': False},
            },
            'template': {
                'revisionSuffix': 'r' + hashlib.sha256((image + digest).encode()).hexdigest()[:16],
                'containers': [{'name': 'gateway', 'image': image,
                    'resources': {'cpu': 0.25, 'memory': '0.5Gi'},
                    'env': [{'name': 'VIDEO_API_TOKEN_SHA256', 'secretRef': 'video-api-token-sha256'}],
                    'probes': [
                        {'type': 'Liveness', 'httpGet': {'path': '/healthz', 'port': 8080}, 'periodSeconds': 30},
                        {'type': 'Readiness', 'httpGet': {'path': '/healthz', 'port': 8080}, 'periodSeconds': 10},
                    ]}],
                'scale': {'minReplicas': 0, 'maxReplicas': 1, 'rules': [
                    {'name': 'http', 'http': {'metadata': {'concurrentRequests': '10'}}}]},
            },
        }, '2024-03-01', location=args.location, tags=tags, dependsOn=[environment_id],
                 identity={'type': 'UserAssigned', 'userAssignedIdentities': {identity['id']: {}}}),
    ]
    template = {
        '$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
        'contentVersion': '1.0.0.0',
        'parameters': {'tokenHash': {'type': 'secureString'}}, 'resources': resources,
        'outputs': {'hostname': {'type': 'string', 'value':
            f"[reference(resourceId('Microsoft.App/containerApps', '{app}'), '2024-03-01').configuration.ingress.fqdn]"}},
    }
    with tempfile.TemporaryDirectory(prefix='makinari-video-') as directory:
        template_path = Path(directory) / 'template.json'
        params_path = Path(directory) / 'parameters.json'
        template_path.write_text(json.dumps(template))
        params_path.write_text(json.dumps({'tokenHash': {'value': digest}}))
        os.chmod(params_path, 0o600)
        print('Validating ARM deployment...', flush=True)
        common = ['--subscription', subscription, '--resource-group', args.group,
                  '--template-file', str(template_path), '--parameters', '@' + str(params_path)]
        az('deployment', 'group', 'validate', *common)
        print('Deploying scale-to-zero foundation (no GPU)...', flush=True)
        result = az('deployment', 'group', 'create', '--name', 'video-foundation', *common)
    host = result['properties']['outputs']['hostname']['value']
    print(json.dumps({'endpoint': 'https://' + host, 'resource_group': args.group,
                      'storage_account': storage, 'credential_file': str(credentials),
                      'generation_enabled': False}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        # Never dump command args, ARM bodies, or provider response bodies containing secrets.
        raise SystemExit(f'Azure operation failed (exit {error.returncode}); inspect the Azure deployment operations securely.')