import { randomBytes, randomUUID } from 'node:crypto';
import { createRequirementExecutionBoundary } from '@/app/api/robots/instance/assistant/requirement-execution-boundary';
import { getAppsAdminClient, issueTenantJWT } from '@/lib/database/apps-supabase';
import { ensureTenant } from '@/lib/services/apps-platform/tenant-provisioner';
import { ensureTenantStorage } from '@/lib/services/apps-platform/tenant-storage';
import { createCapabilityTools } from '../capabilities';
import { createDeliveryTools } from '../delivery-tools';
import { MemorySessionStore } from '../memory-store';
import { createMemoryArtifactStore } from '../artifact-store';
import { createRedactor } from '../security';
import type { HarnessSession, HarnessTool, Workspace } from '../types';

jest.mock('@/lib/database/apps-supabase', () => ({ getAppsAdminClient: jest.fn(), issueTenantJWT: jest.fn() }));
jest.mock('@/lib/services/apps-platform/postgrest-config', () => ({ syncPostgrestSchemas: jest.fn(async () => ({ ok: true })) }));

function fixture() {
  const scope = { siteId: randomUUID(), userId: randomUUID() };
  const requirementId = randomUUID(), tenantId = randomUUID(), instanceId = randomUUID();
  const schema = `app_${requirementId.replaceAll('-', '').slice(0, 24)}`, bucket = `tenant-${schema.slice(4)}`;
  const requirement = { id: requirementId, site_id: scope.siteId, user_id: scope.userId, status: 'in-progress',
    cron_lock_active: false, cron_lock_expires_at: null, metadata: { runner_instance_id: instanceId, requirement_execution_generation: 1 } };
  const runner = { id: instanceId, site_id: scope.siteId, user_id: scope.userId, status: 'paused', is_archived: false };
  const binding = { requirementId, tenantId, schema, bucket, ...scope };
  const token = randomBytes(32).toString('base64url');
  const capabilities = { version: 1, requirement_id: requirementId, tenant_id: tenantId, schema,
    identity: { user_id: `${schema}._app_current_user_id`, claims: `${schema}._app_request_claims`, backend: `${schema}._app_is_backend_request` },
    storage: { available: true, bucket }, backend: { role: 'authenticated', bypasses_rls: false, operations: [] } };
  const config = { version: 1, policy_version: 1, status: 'active', requirement_id: requirementId, tenant_id: tenantId,
    schema, bucket, user_id: scope.userId, site_id: scope.siteId, file_size_limit: 1024, allowed_mime_types: ['image/png'] };
  let storedBucket: unknown = null;
  let provisioned = false, bootstrapEffects = 0;
  const rpc = jest.fn(async (name: string, args: any) => {
    if (name === 'apps_ensure_tenant') {
      expect(args).toMatchObject({ p_requirement_id: requirementId, p_site_id: scope.siteId, p_user_id: scope.userId });
      const created = !provisioned;
      if (created) { provisioned = true; bootstrapEffects++; }
      return { data: { tenant_id: tenantId, schema, bucket, auth_provider: 'supabase', created }, error: null };
    }
    if (name === 'apps_get_tenant_storage_config') {
      expect(args).toEqual({ p_requirement_id: requirementId, p_expected_tenant_id: tenantId });
      return { data: { ...config }, error: null };
    }
    return { data: capabilities, error: null };
  });
  const client = { rpc,
    from: jest.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {
      tenant_id: tenantId, schema, user_id: config.user_id, site_id: config.site_id, status: config.status }, error: null }) }) }) })),
    storage: {
      getBucket: jest.fn(async () => storedBucket ? { data: storedBucket, error: null }
        : { data: null, error: { code: 'NoSuchBucket' } }),
      createBucket: jest.fn(async (name: string, options: any) => {
        storedBucket = { id: name, name, public: options.public, file_size_limit: options.fileSizeLimit, allowed_mime_types: options.allowedMimeTypes };
        return { data: storedBucket, error: null };
      }),
    },
  };
  (getAppsAdminClient as jest.Mock).mockReturnValue(client);
  (issueTenantJWT as jest.Mock).mockResolvedValue({ token, expires_at: new Date(Date.now() + 900000).toISOString() });
  const workspace = { ref: { provider: 'vercel', id: randomUUID(), root: '/vercel/sandbox' },
    readFile: jest.fn(), writeFile: jest.fn(), exec: jest.fn(), processStatus: jest.fn(), stopProcess: jest.fn(), suspend: jest.fn() } as Workspace;
  const assertActive = jest.fn(async () => {});
  const configureEnvironment = jest.fn(async (_values: Record<string, string>) => {});
  const options = { scope, requirementId, workspace, assertActive, configureEnvironment,
    allowed: ['sandbox_db_provision', 'sandbox_storage_ensure', 'sandbox_db_migrate'] };
  const deps = { loadRequirement: jest.fn(async () => requirement), loadRunner: jest.fn(async () => runner),
    // Real providers, only their external transport is fake. Not an idempotent stub adapter.
    ensureTenant: jest.fn(ensureTenant), ensureStorage: jest.fn(ensureTenantStorage),
    storageBinding: jest.fn(async () => ({ ...binding })),
    issueTenantJWT: jest.fn(async () => ({ token, expires_at: new Date(Date.now() + 900000).toISOString() })),
    publicConfig: jest.fn(async () => ({ url: 'https://apps.example.invalid', anonKey: randomBytes(32).toString('hex') })),
    migrate: jest.fn(async () => ({ applied: [], errors: [] })),
  };
  async function boundary(tools: HarnessTool[]) {
    const sessionId = randomUUID(), owner = randomUUID();
    const store = new MemorySessionStore();
    const initial: HarnessSession = { id: sessionId, version: 0, status: 'queued',
      request: { objective: 'Offline recovery test', requirementId, repository: { url: 'https://example.invalid/repo' },
        limits: { maxTurns: 20, maxOutputTokens: 1000, maxTotalTokens: 1000000, maxActiveMs: 600000 } },
      messages: [], turns: 0, allocatedTokens: 0, activeMs: 0, uncertainOperations: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await store.create(initial, scope);
    const session = (await store.claim(sessionId, scope.siteId, owner, 300))!;
    const adapter = createRequirementExecutionBoundary({ session, store, owner, tools, assertActive,
      run: { ...scope, requirementId, instanceId, sessionId, runId: randomUUID(), executionGeneration: 1 },
      artifacts: createMemoryArtifactStore(store), redact: createRedactor([token]), signal: new AbortController().signal,
      writeLog: async () => {} });
    await adapter.initialize();
    const call = async (name: string, args = {}) => {
      const id = randomUUID();
      await adapter.boundary.beforeModel({ system: 'Offline', messages: adapter.getMessages(), tools: [], maxOutputTokens: 100 });
      await adapter.boundary.onModelMessage({ role: 'assistant', content: '', tool_calls: [
        { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ] });
      const result = await adapter.boundary.executeTool({ name, id, args }, () => adapter.executeHarnessTool(name, args));
      await adapter.boundary.afterTurn([]);
      expect(JSON.stringify(adapter.getSession())).not.toContain(token);
      return result;
    };
    return { adapter, call };
  }
  return { options, deps, scope, requirement, runner, binding, config, client, token, workspace, configureEnvironment,
    boundary, bootstrapEffects: () => bootstrapEffects };
}

test('provision: fresh canonical attempt after lost environment acknowledgement reuses tenant and bucket', async () => {
  const f = fixture();
  f.configureEnvironment.mockRejectedValueOnce(new Error('Lost environment acknowledgement'));
  const b = await f.boundary(await createCapabilityTools(f.options, f.deps));
  expect(await b.call('sandbox_db_provision')).toMatchObject({ ok: false, error: { ambiguous: true } });
  expect(f.bootstrapEffects()).toBe(1);
  expect(f.deps.ensureTenant).toHaveBeenCalledTimes(1); // no automatic replay
  expect(await b.call('sandbox_db_provision')).toMatchObject({ ok: true, output: { created: false } });
  expect(f.bootstrapEffects()).toBe(1);
  expect(f.client.storage.createBucket).toHaveBeenCalledTimes(1);
  expect(f.configureEnvironment).toHaveBeenCalledTimes(2);
  expect(f.deps.ensureTenant.mock.calls[0]).toEqual(f.deps.ensureTenant.mock.calls[1]);
  expect(b.adapter.getSession().uncertainOperations).toHaveLength(1); // history not erased
});

test('storage: lost create response is recovered by real provider read-back, not a second create', async () => {
  const f = fixture();
  const create = f.client.storage.createBucket.getMockImplementation()!;
  f.client.storage.createBucket.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('Lost response'); });
  const b = await f.boundary(await createCapabilityTools(f.options, f.deps));
  expect(await b.call('sandbox_storage_ensure')).toMatchObject({ ok: false, error: { ambiguous: true } });
  expect(f.client.storage.createBucket).toHaveBeenCalledTimes(1);
  expect(await b.call('sandbox_storage_ensure')).toMatchObject({ ok: true, output: { created: false, bucket: f.binding.bucket } });
  expect(f.client.storage.createBucket).toHaveBeenCalledTimes(1);
  expect(f.deps.ensureStorage.mock.calls[0][0]).toEqual(f.deps.ensureStorage.mock.calls[1][0]);
});

test.each(['owner', 'site', 'generation', 'runner', 'lease'])('fresh provisioning rechecks %s after ambiguity before effects', async change => {
  const f = fixture();
  f.configureEnvironment.mockRejectedValueOnce(new Error('Lost acknowledgement'));
  const b = await f.boundary(await createCapabilityTools(f.options, f.deps));
  expect(await b.call('sandbox_db_provision')).toMatchObject({ ok: false });
  if (change === 'owner') f.requirement.user_id = randomUUID();
  if (change === 'site') f.requirement.site_id = randomUUID();
  if (change === 'generation') f.requirement.metadata.requirement_execution_generation++;
  if (change === 'runner') f.runner.status = 'running';
  if (change === 'lease') f.options.assertActive.mockRejectedValue(new Error('Permission revoked'));
  if (change === 'lease') await expect(b.call('sandbox_db_provision')).rejects.toMatchObject({ name: 'RecoveryError' });
  else expect(await b.call('sandbox_db_provision')).toMatchObject({ ok: false });
  expect(f.deps.ensureTenant).toHaveBeenCalledTimes(1);
  expect(f.configureEnvironment).toHaveBeenCalledTimes(1);
  expect(f.client.storage.createBucket).toHaveBeenCalledTimes(1);
});

test.each(['site_id', 'user_id', 'policy_version'])('storage recovery rechecks provider %s and performs no new effect on revocation', async field => {
  const f = fixture();
  const create = f.client.storage.createBucket.getMockImplementation()!;
  f.client.storage.createBucket.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('Lost response'); });
  const b = await f.boundary(await createCapabilityTools(f.options, f.deps));
  expect(await b.call('sandbox_storage_ensure')).toMatchObject({ ok: false });
  Object.assign(f.config, { [field]: field === 'policy_version' ? 2 : randomUUID() });
  expect(await b.call('sandbox_storage_ensure')).toMatchObject({ ok: false });
  expect(f.client.storage.createBucket).toHaveBeenCalledTimes(1);
});

test.each(['site_id', 'user_id'])('provision recovery refuses provider registry %s changes before credentials or storage', async field => {
  const f = fixture();
  f.configureEnvironment.mockRejectedValueOnce(new Error('Lost acknowledgement'));
  const b = await f.boundary(await createCapabilityTools(f.options, f.deps));
  expect(await b.call('sandbox_db_provision')).toMatchObject({ ok: false });
  const mintCount = (issueTenantJWT as jest.Mock).mock.calls.length;
  const storageReads = f.client.storage.getBucket.mock.calls.length;
  Object.assign(f.config, { [field]: randomUUID() });
  expect(await b.call('sandbox_db_provision')).toMatchObject({ ok: false });
  expect(f.bootstrapEffects()).toBe(1);
  expect(f.client.storage.getBucket).toHaveBeenCalledTimes(storageReads);
  expect(issueTenantJWT).toHaveBeenCalledTimes(mintCount);
  expect(f.deps.issueTenantJWT).toHaveBeenCalledTimes(1);
  expect(f.configureEnvironment).toHaveBeenCalledTimes(1);
});

test('storage rejects a retargeted host binding before the provider runs', async () => {
  const f = fixture();
  f.binding.requirementId = randomUUID();
  const b = await f.boundary(await createCapabilityTools(f.options, f.deps));
  expect(await b.call('sandbox_storage_ensure')).toMatchObject({ ok: false, error: { code: 'TENANT_UNAVAILABLE' } });
  expect(f.deps.ensureStorage).not.toHaveBeenCalled();
  expect(f.client.rpc).not.toHaveBeenCalled();
});

test('storage recovery never repairs or widens a mismatching existing bucket', async () => {
  const f = fixture();
  const create = f.client.storage.createBucket.getMockImplementation()!;
  f.client.storage.createBucket.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('Lost response'); });
  const b = await f.boundary(await createCapabilityTools(f.options, f.deps));
  expect(await b.call('sandbox_storage_ensure')).toMatchObject({ ok: false });
  f.client.storage.getBucket.mockResolvedValue({ data: { id: f.binding.bucket, name: f.binding.bucket, public: true,
    file_size_limit: f.config.file_size_limit, allowed_mime_types: f.config.allowed_mime_types }, error: null });
  expect(await b.call('sandbox_storage_ensure')).toMatchObject({ ok: false });
  expect(f.client.storage.createBucket).toHaveBeenCalledTimes(1);
});

test('migration: ambiguous mutable batch stays fenced on a fresh canonical request', async () => {
  const f = fixture();
  // A partially applied batch with unavailable receipt lookup cannot justify new SQL.
  f.deps.migrate.mockRejectedValueOnce(new Error('Lost batch outcome'));
  const b = await f.boundary(await createCapabilityTools(f.options, f.deps));
  expect(await b.call('sandbox_db_migrate')).toMatchObject({ ok: false, error: { ambiguous: true } });
  expect(await b.call('sandbox_db_migrate')).toMatchObject({ ok: false, error: { code: 'OPERATION_RETRY_UNSAFE' } });
  expect(f.deps.migrate).toHaveBeenCalledTimes(1);
  expect(f.deps.ensureTenant).not.toHaveBeenCalled();
});

test('tracking: real transform reads current source after ambiguous write and adds no duplicate effect', async () => {
  const f = fixture();
  let source = 'export default function Layout(){return <html><body>Hello</body></html>}';
  (f.workspace.readFile as jest.Mock).mockImplementation(async () => source);
  (f.workspace.writeFile as jest.Mock).mockImplementation(async (_path, text) => { source = text; throw new Error('Lost write acknowledgement'); });
  const tools = createDeliveryTools({ workspace: f.workspace, scope: f.scope,
    profile: { allowed: ['tracking_install'] } });
  expect(tools[0].recoveryPolicy).toBe('inspect');
  expect(tools[0].reconcile).toBeUndefined();
  const b = await f.boundary(tools);
  expect(await b.call('tracking_install', { path: 'web/layout.tsx' })).toMatchObject({ ok: false, error: { ambiguous: true } });
  source = source.replace('Hello', 'Independent edit');
  expect(await b.call('tracking_install', { path: 'web/layout.tsx' })).toMatchObject({ ok: true, output: { changed: false } });
  expect(source).toContain('Independent edit');
  expect(source.match(/data-uncodie-harness=/g)).toHaveLength(1);
  expect(f.workspace.writeFile).toHaveBeenCalledTimes(1);
  expect(f.workspace.exec).not.toHaveBeenCalled();
});

test('tracking recovery refuses unsupported current source without overwriting it', async () => {
  const f = fixture();
  let source = 'export default function Layout(){return <html><body>Hello</body></html>}';
  (f.workspace.readFile as jest.Mock).mockImplementation(async () => source);
  (f.workspace.writeFile as jest.Mock).mockImplementation(async (_path, text) => { source = text; throw new Error('Lost acknowledgement'); });
  const b = await f.boundary(createDeliveryTools({ workspace: f.workspace, scope: f.scope,
    profile: { allowed: ['tracking_install'] } }));
  expect(await b.call('tracking_install', { path: 'layout.tsx' })).toMatchObject({ ok: false });
  source = 'export default function Layout(){return <main>Changed layout</main>}';
  expect(await b.call('tracking_install', { path: 'layout.tsx' })).toMatchObject({ ok: false, error: { effectStarted: false } });
  expect(f.workspace.writeFile).toHaveBeenCalledTimes(1);
  expect(source).toContain('Changed layout');
});