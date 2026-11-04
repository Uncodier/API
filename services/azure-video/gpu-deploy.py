#!/usr/bin/env python3
"""Gated AML provisioning plan (stdlib + az rest; no az ml extension).

Default is read-only preflight plus JSON plan. --apply explicitly deploys infrastructure,
never submits inference. License reference is an operator attestation, not legal review.
Schemas: learn.microsoft.com/azure/templates/microsoft.machinelearningservices/2024-10-01/
workspaces, workspaces/computes, workspaces/environments/versions.
Narrow RBAC is intentional: no Contributor on the existing shared ACR/storage.
AML provider control-plane permissions and network/image-pull access must still be
validated by an operator before activation; this is not a validated production stack.
"""
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
import uuid
from pathlib import Path

API = '2024-10-01'
ARM = 'https://management.azure.com'
UUID = r'[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}'


def az(*args):
    result = subprocess.run(['az', *args, '--only-show-errors', '--output', 'json'],
                            check=True, capture_output=True, text=True)
    return json.loads(result.stdout) if result.stdout.strip() else None


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(args):
    require(re.fullmatch(UUID, args.subscription), 'Invalid subscription')
    for name in (args.group, args.workspace, args.compute):
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,62}', name), 'Invalid resource name')
    require(re.fullmatch(r'[a-z0-9]+', args.location), 'Invalid location')
    require(re.fullmatch(r'Standard_N[A-Za-z0-9_]+', args.sku), 'A GPU SKU is required')
    require(re.fullmatch(r'[a-z0-9][a-z0-9.-]+/[a-z0-9/_.-]+@sha256:[a-f0-9]{64}', args.image),
            'Explicit immutable worker image digest required')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}', args.license_proof_ref),
            'License proof reference required (non-secret document identifier, not signed URL)')
    prefix = rf'/subscriptions/{UUID}/resourceGroups/[A-Za-z0-9_-]+/providers/'
    for value, suffix in [(args.storage_id, r'Microsoft.Storage/storageAccounts/[a-z0-9]{3,24}'),
                          (args.registry_id, r'Microsoft.ContainerRegistry/registries/[A-Za-z0-9]+')]:
        require(re.fullmatch(prefix + suffix, value), 'Invalid linked resource ID')
        require(value.lower().startswith('/subscriptions/' + args.subscription.lower() + '/'),
                'Linked resources must use the deployment subscription')
    require(re.fullmatch(UUID, args.dispatcher_principal_id), 'Dispatcher identity principal ID required')


def quota_preflight(args, call=az):
    """Fail closed on unknown/absent quota; quota is not a capacity reservation."""
    base = f'{ARM}/subscriptions/{args.subscription}/providers/Microsoft.MachineLearningServices/locations/{args.location}'
    sizes = call('rest', '--method', 'get', '--url', f'{base}/vmSizes?api-version={API}')
    matches = [v for v in sizes.get('value', []) if v.get('name', '').lower() == args.sku.lower()]
    require(len(matches) == 1, 'SKU unavailable in AML region')
    size = matches[0]
    cores = size.get('vCPUs')
    require(type(cores) is int and cores > 0 and size.get('gpus', 0) > 0
            and 'AmlCompute' in size.get('supportedComputeTypes', []), 'SKU is not supported GPU AmlCompute')
    usages, url = [], f'{base}/usages?api-version={API}'
    seen = set()
    while url:
        require(url.startswith(base + '/usages?') and url not in seen and len(seen) < 20,
                'Invalid quota pagination')
        seen.add(url)
        page = call('rest', '--method', 'get', '--url', url)
        usages.extend(page.get('value', []))
        url = page.get('nextLink')
    norm = lambda text: re.sub(r'[^a-z0-9]', '', text.lower())
    family = norm(size.get('family', ''))
    require(bool(family), 'Unknown SKU quota family')
    family_quota = family + 'clusterdedicatedvcpus'
    # Current service uses machine-readable family names and typed dedicated/
    # lowPriority rows; older documented responses use human-readable names.
    for names, count, live_type in [
        ({family_quota, family}, cores, 'microsoft.machinelearningservices/vmfamily/dedicatedcores/usages'),
        ({'totalclusterdedicatedregionalvcpus', 'totaldedicatedcores'}, cores,
         'microsoft.machinelearningservices/totaldedicatedcores/usages'),
        ({'clusters', 'totalclusters'}, 1, 'microsoft.machinelearningservices/totalclusters/usages')]:
        rows = [u for u in usages if norm(u.get('name', {}).get('value', '')) in names
                and '/workspaces/' not in u.get('id', '').lower()
                and 'lowpriority' not in u.get('type', '').lower()
                and (norm(u.get('name', {}).get('value', '')) not in {family, 'totaldedicatedcores', 'totalclusters'}
                     or u.get('type', '').lower() == live_type)]
        require(len(rows) == 1, 'Required AML quota absent or ambiguous')
        row = rows[0]
        require(row.get('unit') == 'Count' and type(row.get('limit')) is int
                and type(row.get('currentValue')) is int and row['currentValue'] >= 0
                and row['limit'] - row['currentValue'] >= count, 'Insufficient approved AML quota')
    return {'sku': size['name'], 'cores': cores, 'quota_checked': True, 'capacity_guaranteed': False}


def build_template(args):
    validate(args)
    base = f'/subscriptions/{args.subscription}/resourceGroups/{args.group}/providers/'
    workspace = base + 'Microsoft.MachineLearningServices/workspaces/' + args.workspace
    suffix = hashlib.sha256(workspace.encode()).hexdigest()[:12]
    vault_name = 'video-kv-' + suffix
    vault = base + 'Microsoft.KeyVault/vaults/' + vault_name
    resources = []

    def add(kind, name, properties, version=API, **extra):
        item = {'type': kind, 'apiVersion': version, 'name': name, 'properties': properties, **extra}
        resources.append(item)
        return item

    identities = {}
    for label in ['workspace', 'worker']:
        name = 'video-' + label + '-' + suffix
        rid = base + 'Microsoft.ManagedIdentity/userAssignedIdentities/' + name
        add('Microsoft.ManagedIdentity/userAssignedIdentities', name, {}, '2023-01-31', location=args.location)
        identities[label] = rid

    def principal(rid):
        return f"[reference('{rid}', '2023-01-31').principalId]"

    def grant(scope, role, who, dependencies):
        name = str(uuid.uuid5(uuid.NAMESPACE_URL, scope + role + who))
        add('Microsoft.Authorization/roleAssignments', name, {
            'roleDefinitionId': role if role.startswith('/') else f'/subscriptions/{args.subscription}/providers/Microsoft.Authorization/roleDefinitions/{role}',
            'principalId': who, 'principalType': 'ServicePrincipal'}, '2022-04-01',
            scope=scope, dependsOn=dependencies)
        return scope + '/providers/Microsoft.Authorization/roleAssignments/' + name

    add('Microsoft.KeyVault/vaults', vault_name, {
        'tenantId': '[subscription().tenantId]', 'sku': {'family': 'A', 'name': 'standard'},
        'enableRbacAuthorization': True, 'enableSoftDelete': True, 'enablePurgeProtection': True,
        'softDeleteRetentionInDays': 7, 'accessPolicies': []}, '2023-07-01', location=args.location)
    ws_identity, worker = identities['workspace'], identities['worker']
    prerequisites = [vault, ws_identity]
    for scope, role in [
        (args.storage_id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'),  # Blob Data Contributor, AML logs
        (vault, 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'),  # Secrets Officer, this vault only
        (args.registry_id, '7f951dda-4ed3-4680-a7ca-43fe172d538d')]:
        prerequisites.append(grant(scope, role, principal(ws_identity), [ws_identity] + ([vault] if scope == vault else [])))
    for container in ['jobs', 'videos']:
        grant(args.storage_id + '/blobServices/default/containers/' + container,
              'ba92f5b4-2d11-453d-a403-e96b0029c9fe', principal(worker), [worker])
    grant(args.storage_id + '/queueServices/default/queues/video-jobs',
          '8a0f0c08-91a1-4084-bc3d-661d67233fed', principal(worker), [worker])
    grant(args.registry_id, '7f951dda-4ed3-4680-a7ca-43fe172d538d', principal(worker), [worker])
    add('Microsoft.MachineLearningServices/workspaces', args.workspace, {
        'storageAccount': args.storage_id, 'containerRegistry': args.registry_id, 'keyVault': vault,
        'primaryUserAssignedIdentity': ws_identity, 'systemDatastoresAuthMode': 'Identity',
        'publicNetworkAccess': 'Enabled', 'allowPublicAccessWhenBehindVnet': False},
        location=args.location, identity={'type': 'UserAssigned', 'userAssignedIdentities': {ws_identity: {}}},
        dependsOn=prerequisites)
    add('Microsoft.MachineLearningServices/workspaces/computes', args.workspace + '/' + args.compute, {
        'computeType': 'AmlCompute', 'disableLocalAuth': True, 'properties': {
            'vmSize': args.sku, 'vmPriority': 'Dedicated', 'osType': 'Linux',
            'remoteLoginPortPublicAccess': 'Disabled',
            'scaleSettings': {'minNodeCount': 0, 'maxNodeCount': 1, 'nodeIdleTimeBeforeScaleDown': 'PT120S'}}},
        location=args.location, identity={'type': 'UserAssigned', 'userAssignedIdentities': {worker: {}}},
        dependsOn=[workspace, worker])
    version = args.image.split('@sha256:')[1]
    add('Microsoft.MachineLearningServices/workspaces/environments', args.workspace + '/video-worker',
        {}, dependsOn=[workspace])
    add('Microsoft.MachineLearningServices/workspaces/environments/versions',
        args.workspace + '/video-worker/' + version,
        {'image': args.image, 'osType': 'Linux', 'autoRebuild': 'Disabled',
         'description': 'Unvalidated H3 worker; license proof must be reviewed before dispatch.'},
        dependsOn=[workspace + '/environments/video-worker'])
    role = str(uuid.uuid5(uuid.NAMESPACE_URL, workspace + '/video-dispatch-role'))
    role_id = base + 'Microsoft.Authorization/roleDefinitions/' + role
    add('Microsoft.Authorization/roleDefinitions', role, {
        'roleName': 'Video AML dispatch ' + suffix, 'type': 'CustomRole',
        'assignableScopes': [f'/subscriptions/{args.subscription}/resourceGroups/{args.group}'],
        'permissions': [{'actions': ['Microsoft.MachineLearningServices/workspaces/read',
            'Microsoft.MachineLearningServices/workspaces/jobs/read',
            'Microsoft.MachineLearningServices/workspaces/jobs/write',
            'Microsoft.MachineLearningServices/workspaces/computes/read',
            'Microsoft.MachineLearningServices/workspaces/environments/versions/read'],
            'notActions': [], 'dataActions': [], 'notDataActions': []}]}, '2022-04-01')
    grant(workspace, role_id, args.dispatcher_principal_id, [workspace, role_id])
    return {'$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
            'contentVersion': '1.0.0.0', 'resources': resources,
            'outputs': {'workspaceId': {'type': 'string', 'value': workspace},
                        'workerIdentityId': {'type': 'string', 'value': worker},
                        'workerClientId': {'type': 'string', 'value': f"[reference('{worker}', '2023-01-31').clientId]"},
                        'environmentId': {'type': 'string', 'value': workspace + '/environments/video-worker/versions/' + version}}}


def main(argv=None, call=az):
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ['subscription', 'group', 'storage-id', 'registry-id', 'image', 'license-proof-ref', 'dispatcher-principal-id']:
        parser.add_argument('--' + field, required=True)
    parser.add_argument('--location', default='centralus')
    parser.add_argument('--workspace', default='video-ml')
    parser.add_argument('--compute', default='video-gpu')
    parser.add_argument('--sku', default='Standard_NC96ads_A100_v4')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    template = build_template(args)  # local validation before any Azure operation
    quota = quota_preflight(args, call)
    # Read-only dependency checks before deployment, including scoped container RBAC targets.
    for rid in [args.storage_id, args.registry_id]:
        call('resource', 'show', '--ids', rid)
    for container in ['jobs', 'videos']:
        call('rest', '--method', 'get', '--url', ARM + args.storage_id +
             '/blobServices/default/containers/' + container + '?api-version=2023-05-01')
    call('rest', '--method', 'get', '--url', ARM + args.storage_id +
         '/queueServices/default/queues/video-jobs?api-version=2023-05-01')
    registry = call('resource', 'show', '--ids', args.registry_id)
    props = registry.get('properties', {})
    require(props.get('roleAssignmentMode') in (None, 'LegacyRegistryPermissions'), 'ABAC registry requires separate reviewed repository roles')
    require(args.image.startswith(props.get('loginServer', '') + '/'), 'Worker image must belong to linked ACR')
    auth = call('acr', 'config', 'authentication-as-arm', 'show', '--subscription', args.subscription,
                '--registry', args.registry_id.rsplit('/', 1)[1])
    require(auth.get('status') == 'enabled', 'ACR ARM authentication must already be enabled')
    if not args.apply:
        print(json.dumps({'mode': 'plan', 'inference_verified': False, 'runtime_rbac_verified': False,
                          'quota': quota, 'template': template}, indent=2))
        return
    with tempfile.TemporaryDirectory(prefix='video-gpu-') as directory:
        path = Path(directory) / 'template.json'
        path.write_text(json.dumps(template))
        common = ['--subscription', args.subscription, '--resource-group', args.group, '--template-file', str(path)]
        call('deployment', 'group', 'validate', *common)
        call('deployment', 'group', 'create', '--name', 'video-gpu', *common)
    print(json.dumps({'infrastructure_deployed': True, 'inference_verified': False, 'jobs_submitted': 0}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError):
        raise SystemExit('GPU provisioning blocked or Azure operation failed; no inference was submitted. Inspect configuration/quota securely.')