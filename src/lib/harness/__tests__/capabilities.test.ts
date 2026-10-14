import { WORKSPACE_ISOLATION_VERSION, WORKSPACE_PROCESS_GUARD } from '../workspace-process-guard';
import { randomBytes, randomUUID } from 'node:crypto';
import { CAPABILITY_MANIFEST, createCapabilityTools, type CapabilityDependencies, type CapabilityOptions } from '../capabilities';
import type { HarnessTool, ToolContext, Workspace } from '../types';

const sdkGet = jest.fn();
const qaExecute = jest.fn();
jest.mock('@vercel/sandbox', () => ({ Sandbox: { get: (...args: unknown[]) => sdkGet(...args) } }));
jest.mock('@/app/api/agents/tools/sandbox/qa-tools', () => ({ getQaSandboxTools: (sandbox: unknown, requirementId: unknown, toolsCtx: unknown) =>
  ['sandbox_run_scenario', 'sandbox_probe_routes'].map(name => ({ name, execute: (args: unknown) => qaExecute(name, args, sandbox, requirementId, toolsCtx) })) }));

function setup() {
  const siteId = randomUUID(), userId = randomUUID(), requirementId = randomUUID(), runnerId = randomUUID();
  const schema = `app_${requirementId.replace(/-/g, '').slice(0, 24)}`;
  const tenantId = randomUUID(), bucket = `tenant-${schema.slice(4)}`;
  // Never literals or real credentials: security assertions exercise runtime-generated values.
  const oldToken = randomBytes(32).toString('base64url');
  const newToken = randomBytes(32).toString('base64url');
  const password = randomBytes(32).toString('base64url');
  const anonKey = randomBytes(32).toString('base64url');
  const capabilities = { version: 1 as const, requirement_id: requirementId, tenant_id: tenantId, schema,
    identity: { user_id: `${schema}._app_current_user_id`, claims: `${schema}._app_request_claims`, backend: `${schema}._app_is_backend_request` },
    storage: { available: true, bucket }, backend: { role: 'authenticated' as const, bypasses_rls: false as const, operations: [] } };
  const requirement = { id: requirementId, site_id: siteId, user_id: userId, status: 'in-progress',
    cron_lock_active: false, cron_lock_expires_at: null as string | null,
    metadata: { runner_instance_id: runnerId, requirement_execution_generation: 4 } };
  const runner = { id: runnerId, site_id: siteId, user_id: userId, status: 'paused', is_archived: false };
  const workspace = { ref: { provider: 'vercel', id: `h-${randomUUID()}`, root: '/vercel/sandbox' },
    exec: jest.fn(), readFile: jest.fn(), writeFile: jest.fn(), processStatus: jest.fn(), stopProcess: jest.fn(), suspend: jest.fn() } as Workspace;
  const options: CapabilityOptions = { scope: { siteId, userId }, requirementId, workspace,
    allowed: CAPABILITY_MANIFEST.implemented.map(entry => entry.name), assertActive: jest.fn().mockResolvedValue(undefined),
    configureEnvironment: jest.fn().mockResolvedValue(undefined) };
  const context: ToolContext = { sessionId: randomUUID(), operationId: randomUUID(), signal: new AbortController().signal,
    assertActive: jest.fn().mockResolvedValue(undefined) };
  const deps = {
    loadRequirement: jest.fn().mockImplementation(async () => requirement),
    loadRunner: jest.fn().mockImplementation(async () => runner),
    ensureTenant: jest.fn().mockResolvedValue({ tenant_id: tenantId, schema, bucket, jwt: oldToken,
      jwt_expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), auth_provider: 'supabase', created: true, capabilities }),
    issueTenantJWT: jest.fn().mockResolvedValue({ token: newToken, expires_at: new Date(Date.now() + 900000).toISOString() }),
    publicConfig: jest.fn().mockResolvedValue({ url: 'https://apps.example.test', anonKey }),
    tenantCapabilities: jest.fn().mockResolvedValue(capabilities),
    storageBinding: jest.fn().mockResolvedValue({ requirementId, tenantId, schema, bucket, siteId, userId }),
    ensureStorage: jest.fn().mockResolvedValue({ bucket, created: false }), verifyStorage: jest.fn().mockResolvedValue(undefined),
    inspect: jest.fn().mockResolvedValue({ success: true, sample_data: [{ password, note: oldToken }],
      receipt: { kind: 'database_schema_snapshot', schema, table: 'records', accessible: true, row_sampled: true } }),
    migrate: jest.fn().mockResolvedValue({ applied: ['migrations/001.sql'], errors: [] }),
    legacy: jest.fn().mockResolvedValue({ ok: true, evidence_persisted: false }),
    installBrowser: jest.fn().mockResolvedValue(undefined),
  } satisfies CapabilityDependencies;
  const build = () => createCapabilityTools(options, deps);
  const invoke = async (name: string, args: Record<string, unknown> = {}, tools?: HarnessTool[]) => {
    const tool = (tools || await build()).find(entry => entry.name === name);
    if (!tool) throw new Error('Test requested unexposed tool');
    return tool.execute(args, context);
  };
  return { options, context, deps, build, invoke, requirement, runner, capabilities, oldToken, newToken, password, anonKey, bucket, schema };
}

it('constructs without DB/SDK/network and never dispatches unlisted or model-selected internal tools', async () => {
  const s = setup();
  s.options.allowed = ['sandbox_db_inspect', 'getAssistantTools', 'deployment_trigger'];
  delete s.options.requirementId;
  const tools = await s.build();
  expect(tools.map(tool => tool.name)).toEqual(['capability_manifest', 'sandbox_db_inspect']);
  Object.values(s.deps).forEach(fn => expect(fn).not.toHaveBeenCalled());
  const manifest = await s.invoke('capability_manifest', {}, tools);
  expect(manifest.ok).toBe(true);
  expect(JSON.stringify(manifest)).toContain('requirement_binding_required');
  expect(JSON.stringify(manifest)).toContain('runtime delivery-tools');
  expect(await s.invoke('sandbox_db_inspect', { table_name: 'records' }, tools)).toMatchObject({ ok: false, error: { code: 'REQUIREMENT_BINDING_REQUIRED' } });
  expect(s.deps.inspect).not.toHaveBeenCalled();
});

it('provisions only host-bound identities and emits credential names, never token values', async () => {
  const s = setup();
  const tools = await s.build();
  const receipt = await s.invoke('sandbox_db_provision', {}, tools);
  expect(receipt.ok).toBe(true);
  expect(s.deps.ensureTenant).toHaveBeenCalledWith({ requirement_id: s.requirement.id, site_id: s.requirement.site_id, user_id: s.requirement.user_id });
  expect(s.deps.issueTenantJWT).toHaveBeenCalledWith({ tenant_id: s.capabilities.tenant_id, schema: s.schema, user_id: s.requirement.user_id, expiresInSec: 900 });
  expect(s.options.configureEnvironment).toHaveBeenCalledWith(expect.objectContaining({ SUPABASE_JWT: s.newToken,
    SUPABASE_STORAGE_BUCKET: s.bucket, NEXT_PUBLIC_SUPABASE_URL: 'https://apps.example.test' }));
  const configured = (s.options.configureEnvironment as jest.Mock).mock.calls[0][0];
  expect(Object.values(configured)).not.toContain(s.oldToken);
  expect(Object.keys(configured).some(name => /SERVICE_ROLE|JWT_SECRET|SERVICE_KEY/.test(name))).toBe(false);
  const serialized = JSON.stringify(receipt);
  for (const secret of [s.oldToken, s.newToken, s.password, s.anonKey]) expect(serialized).not.toContain(secret);
  expect(serialized).toContain('SUPABASE_JWT');
  expect(s.options.workspace.writeFile).not.toHaveBeenCalled();
  expect(s.options.workspace.exec).not.toHaveBeenCalled();
});

it('does not advertise optional storage when ensureTenant reports it unavailable', async () => {
  const s = setup();
  s.capabilities.storage.available = false;
  const result = await s.invoke('sandbox_db_provision');
  expect(result.ok).toBe(true);
  expect((s.options.configureEnvironment as jest.Mock).mock.calls[0][0]).not.toHaveProperty('SUPABASE_STORAGE_BUCKET');
});

it.each([
  ['site', (s: ReturnType<typeof setup>) => { s.requirement.site_id = randomUUID(); }, 'REQUIREMENT_BINDING_INVALID'],
  ['user', (s: ReturnType<typeof setup>) => { s.requirement.user_id = randomUUID(); }, 'REQUIREMENT_BINDING_INVALID'],
  ['status', (s: ReturnType<typeof setup>) => { s.requirement.status = 'done'; }, 'REQUIREMENT_BINDING_INVALID'],
  ['active cron', (s: ReturnType<typeof setup>) => { s.requirement.cron_lock_active = true; }, 'LEGACY_RUNNER_BUSY'],
  ['cron expiry', (s: ReturnType<typeof setup>) => { s.requirement.cron_lock_expires_at = new Date(Date.now() + 60000).toISOString(); }, 'LEGACY_RUNNER_BUSY'],
  ['invalid expiry', (s: ReturnType<typeof setup>) => { s.requirement.cron_lock_expires_at = 'invalid'; }, 'LEGACY_RUNNER_BUSY'],
  ['archived runner', (s: ReturnType<typeof setup>) => { s.runner.is_archived = true; }, 'LEGACY_RUNNER_NOT_DRAINED'],
  ['running runner', (s: ReturnType<typeof setup>) => { s.runner.status = 'running'; }, 'LEGACY_RUNNER_NOT_DRAINED'],
])('refuses %s without dispatch or lifecycle mutations', async (_name, mutate, code) => {
  const s = setup(); mutate(s);
  expect(await s.invoke('sandbox_db_provision')).toMatchObject({ ok: false, error: { code } });
  expect(s.deps.ensureTenant).not.toHaveBeenCalled();
  expect(s.options.configureEnvironment).not.toHaveBeenCalled();
});

it('revalidates scope on every call and pins runner generation within the slice', async () => {
  const s = setup(), tools = await s.build();
  expect((await s.invoke('sandbox_db_capabilities', {}, tools)).ok).toBe(true);
  s.requirement.metadata.requirement_execution_generation++;
  expect(await s.invoke('sandbox_db_capabilities', {}, tools)).toMatchObject({ ok: false, error: { code: 'REQUIREMENT_BINDING_CHANGED' } });
  expect(s.deps.tenantCapabilities).toHaveBeenCalledTimes(1);
});

it('does not consult a broken DB binding for local QA or browser capabilities', async () => {
  const s = setup(); s.requirement.status = 'blocked';
  s.deps.legacy.mockResolvedValue({ ok: true });
  const result = await s.invoke('sandbox_probe_routes', { routes: ['/'] });
  expect(result.ok).toBe(true);
  expect(s.deps.loadRequirement).not.toHaveBeenCalled();
  expect(s.deps.loadRunner).not.toHaveBeenCalled();
});

it('parameterless provisioning can reconcile by the provider idempotency contract without trusting model claims', async () => {
  const s = setup();
  const tools = await s.build();
  const provision = tools.find(tool => tool.name === 'sandbox_db_provision')!;
  const result = await provision.reconcile!({}, s.context);
  expect(result.state).toBe('retry_safe');
  expect(s.deps.ensureTenant).not.toHaveBeenCalled();
  s.runner.status = 'running';
  await expect(provision.reconcile!({}, s.context)).rejects.toThrow();
});

it('rejects model identity arguments and malformed table paths before touching a dependency', async () => {
  const s = setup();
  expect(await s.invoke('sandbox_db_provision', { requirementId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
  expect(await s.invoke('sandbox_db_inspect', { table_name: 'public.users' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
  expect(s.deps.loadRequirement).not.toHaveBeenCalled();
});

it('drops the entire DB row sample, not merely recognizable secret field names', async () => {
  const s = setup();
  const result = await s.invoke('sandbox_db_inspect', { table_name: 'records' });
  expect(result).toMatchObject({ ok: true, output: { receipt: { table: 'records', accessible: true } } });
  for (const sensitive of [s.password, s.oldToken]) expect(JSON.stringify(result)).not.toContain(sensitive);
  expect(JSON.stringify(result)).not.toContain('sample_data');
});

it('reuses constrained migration execution with live owner checks and no plan identity', async () => {
  const s = setup();
  const result = await s.invoke('sandbox_db_migrate');
  expect(result).toMatchObject({ ok: true, output: { applied: ['migrations/001.sql'] } });
  const [integration, execution] = s.deps.migrate.mock.calls[0];
  expect(execution).toMatchObject({ requirementId: s.requirement.id, executionGeneration: 4,
    instance: { site_id: s.requirement.site_id, user_id: s.requirement.user_id } });
  expect(execution.instance).not.toHaveProperty('id');
  s.runner.status = 'running';
  await expect(execution.assertCurrent()).rejects.toThrow();
  await expect(integration.assertCurrent()).rejects.toThrow();
});

it('returns migration holds as failures, without pretending QA passed or lifecycle advanced', async () => {
  const s = setup();
  s.deps.migrate.mockResolvedValue({ applied: [], errors: ['Historical migration recovery unresolved'], diagnostic: { code: 'LEGACY_MIGRATION_HOLD' } } as never);
  const result = await s.invoke('sandbox_db_migrate');
  expect(result).toMatchObject({ ok: false, error: { code: 'CAPABILITY_FAILED' }, output: { diagnostic: { code: 'LEGACY_MIGRATION_HOLD' } } });
});

it('storage uses a host registry binding, verifies without provisioning, and rechecks before effects', async () => {
  const s = setup();
  expect((await s.invoke('sandbox_storage_verify')).ok).toBe(true);
  expect(s.deps.ensureTenant).not.toHaveBeenCalled();
  expect(s.deps.ensureStorage).not.toHaveBeenCalled();
  expect(s.deps.verifyStorage).toHaveBeenCalledWith(expect.objectContaining({ requirementId: s.requirement.id, siteId: s.requirement.site_id, userId: s.requirement.user_id }));
  s.deps.storageBinding.mockImplementation(async () => { s.runner.status = 'running'; return { requirementId: s.requirement.id, tenantId: s.capabilities.tenant_id, schema: s.schema, bucket: s.bucket }; });
  expect(await s.invoke('sandbox_storage_ensure')).toMatchObject({ ok: false, error: { code: 'LEGACY_RUNNER_NOT_DRAINED', ambiguous: true } });
  expect(s.deps.ensureStorage).not.toHaveBeenCalled();
});

it('allows generic on-demand QA/browser without requiring a DB and rejects secret lookup/external routing', async () => {
  const s = setup(); delete s.options.requirementId;
  expect((await s.invoke('sandbox_probe_routes', { routes: ['/'] })).ok).toBe(true);
  expect((await s.invoke('sandbox_browser_install')).ok).toBe(true);
  expect((await s.invoke('sandbox_browser', { action: 'open', url: 'http://localhost:3000/' })).ok).toBe(true);
  expect(await s.invoke('sandbox_browser', { action: 'fill', ref: '@e1', value_env: 'HOST_SECRET' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
  expect(await s.invoke('sandbox_browser', { action: 'open', url: 'https://other.example.test/' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
  expect(await s.invoke('sandbox_probe_routes', { routes: ['//other.example.test/'] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
  expect(await s.invoke('sandbox_run_scenario', { scenarios_dir: '../../private' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
  expect(s.deps.loadRequirement).not.toHaveBeenCalled();
  expect(s.deps.ensureTenant).not.toHaveBeenCalled();
});

it('keeps exact legacy visual review input shape and forbids plan/backlog identifiers', async () => {
  const s = setup();
  const args = { screenshots: [{ route: '/', viewport: 'desktop', url: 'private-evidence-locator' }], step: { order: 0, title: 'Review' } };
  expect((await s.invoke('sandbox_visual_critique', args)).ok).toBe(true);
  expect(s.deps.legacy).toHaveBeenCalledWith('sandbox_visual_critique', args, expect.anything());
  expect(await s.invoke('sandbox_visual_critique', { ...args, backlog_item_id: randomUUID() })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
});

it('redacts known old/new credentials and authenticated URL values from later output', async () => {
  const s = setup(), tools = await s.build();
  await s.invoke('sandbox_db_provision', {}, tools);
  const url = new URL('https://private.example.test/path');
  url.username = 'synthetic'; url.password = s.password;
  s.deps.legacy.mockResolvedValue({ ok: true, notes: `${s.oldToken} ${s.newToken} ${url.toString()}`, secret: s.password } as never);
  const result = await s.invoke('sandbox_probe_routes', { routes: ['/'] }, tools);
  for (const sensitive of [s.oldToken, s.newToken, s.password]) expect(JSON.stringify(result)).not.toContain(sensitive);
  expect(JSON.stringify(result)).toContain('[REDACTED]');
});

it('does not leak arbitrary dependency errors and marks potentially applied writes ambiguous', async () => {
  const s = setup();
  s.deps.ensureTenant.mockRejectedValue(new Error(s.password));
  const result = await s.invoke('sandbox_db_provision');
  expect(result).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', ambiguous: true } });
  expect(JSON.stringify(result)).not.toContain(s.password);
});

it('cannot widen host permissions by mutating the original allowed list after construction', async () => {
  const s = setup(); s.options.allowed = ['sandbox_db_inspect'];
  const tools = await s.build(); s.options.allowed.push('sandbox_db_provision');
  expect(tools.map(tool => tool.name)).not.toContain('sandbox_db_provision');
});

it('does no work after cancellation and returns an inactive discovery error as data', async () => {
  const s = setup();
  const abort = new AbortController(); abort.abort(); s.context.signal = abort.signal;
  expect((await s.invoke('sandbox_db_provision')).ok).toBe(false);
  expect(await s.invoke('capability_manifest')).toMatchObject({ ok: false, error: { code: 'SESSION_INACTIVE' } });
  expect(s.deps.ensureTenant).not.toHaveBeenCalled();
});

it('legacy adapter exposes the preview only with its separate tool, preserves ports, and isolates command env', async () => {
  const s = setup(); delete s.options.requirementId;
  const raw = { tags: { harnessIsolation: WORKSPACE_ISOLATION_VERSION }, routes: [{ port: 4100 }], update: jest.fn().mockResolvedValue(undefined),
    runCommand: jest.fn().mockResolvedValue({ exitCode: 0, stdout: async () => 'ok', stderr: async () => '' }) };
  sdkGet.mockResolvedValue(raw);
  qaExecute.mockImplementation(async (_name, _args, sandbox, requirementId, toolsCtx) => {
    expect(requirementId).toBeUndefined(); expect(toolsCtx).toBeUndefined();
    await sandbox.runCommand({ cmd: 'sh', args: ['-c', 'printf ok'], env: { HOST_SECRET: s.password }, timeoutMs: 999999 });
    return { ok: true };
  });
  const { legacy: _legacy, ...overrides } = s.deps;
  const tools = await createCapabilityTools(s.options, overrides);
  expect(raw.update).not.toHaveBeenCalled();
  expect((await s.invoke('sandbox_probe_routes', { routes: ['/'] }, tools)).ok).toBe(true);
  expect(raw.update).not.toHaveBeenCalled();
  expect(await s.invoke('sandbox_run_scenario', {}, tools)).toMatchObject({ ok: false, error: { code: 'PREVIEW_PORT_REQUIRED' } });
  expect(raw.update).not.toHaveBeenCalled();
  expect((await s.invoke('sandbox_preview_expose', {}, tools)).ok).toBe(true);
  expect(raw.update).toHaveBeenCalledWith({ ports: [4100, 3000] }, { signal: s.context.signal });
  raw.routes.push({ port: 3000 });
  expect((await s.invoke('sandbox_run_scenario', {}, tools)).ok).toBe(true);
  expect(raw.update).toHaveBeenCalledTimes(1);
  expect(sdkGet).toHaveBeenCalledWith({ name: s.options.workspace.ref.id, resume: false, signal: s.context.signal });
  expect(raw.runCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: '/usr/bin/env', sudo: true, timeoutMs: 120000,
    args: expect.arrayContaining([WORKSPACE_PROCESS_GUARD, '-i', 'HOME=/tmp', 'sh', '-c', 'printf ok']) }));
  expect(JSON.stringify(raw.runCommand.mock.calls)).not.toContain(s.password);
});

it('optional tools reconnect with the selected host sandbox authentication without sending it to commands', async () => {
  const previous = { ...process.env };
  const token = randomBytes(24).toString('hex');
  try {
    process.env.HARNESS_SANDBOX_AUTH = 'access-token'; process.env.HARNESS_SANDBOX_TOKEN = token;
    process.env.HARNESS_SANDBOX_TEAM_ID = 'team'; process.env.HARNESS_SANDBOX_PROJECT_ID = 'project';
    const s = setup(); delete s.options.requirementId;
    const raw = { tags: { harnessIsolation: WORKSPACE_ISOLATION_VERSION }, runCommand: jest.fn().mockResolvedValue({ exitCode: 0 }) };
    sdkGet.mockResolvedValue(raw);
    qaExecute.mockImplementation(async (_name, _args, sandbox) => {
      await sandbox.runCommand({ cmd: 'printf', args: ['ok'] }); return { ok: true };
    });
    const { legacy: _legacy, ...overrides } = s.deps;
    const tools = await createCapabilityTools(s.options, overrides);
    const result = await s.invoke('sandbox_probe_routes', { routes: ['/'] }, tools);
    expect(result.ok).toBe(true);
    expect(sdkGet).toHaveBeenLastCalledWith(expect.objectContaining({ token, teamId: 'team', projectId: 'project' }));
    expect(JSON.stringify(raw.runCommand.mock.calls)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
  } finally { process.env = previous; }
});

it('optional reconnection returns static authentication findings rather than SDK credentials', async () => {
  const s = setup(); delete s.options.requirementId;
  const secret = randomBytes(24).toString('hex');
  sdkGet.mockRejectedValue(Object.assign(new Error(secret), { name: 'VercelOidcContextError', cause: new Error(secret) }));
  const { legacy: _legacy, ...overrides } = s.deps;
  const tools = await createCapabilityTools(s.options, overrides);
  const result = await s.invoke('sandbox_probe_routes', { routes: ['/'] }, tools);
  expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_AUTH_CONFIGURATION_REQUIRED' } });
  expect(JSON.stringify(result)).not.toContain(secret);
});

it('rejects legacy attempts to change network policy or access privileged SDK methods', async () => {
  const s = setup(); delete s.options.requirementId;
  const raw = { tags: { harnessIsolation: WORKSPACE_ISOLATION_VERSION }, update: jest.fn(), createUser: jest.fn(),
    runCommand: jest.fn(), routes: [] };
  sdkGet.mockResolvedValue(raw);
  const { legacy: _legacy, ...overrides } = s.deps;
  const tools = await createCapabilityTools(s.options, overrides);
  for (const attempt of [
    (sandbox: any) => sandbox.update({ networkPolicy: 'allow-all' }),
    (sandbox: any) => sandbox.createUser('root-equivalent'),
    (sandbox: any) => sandbox.runCommand({ cmd: 'sh', sudo: true }),
  ]) {
    qaExecute.mockImplementation(async (_name, _args, sandbox) => attempt(sandbox));
    expect((await s.invoke('sandbox_probe_routes', { routes: ['/'] }, tools)).ok).toBe(false);
  }
  expect(raw.update).not.toHaveBeenCalled(); expect(raw.createUser).not.toHaveBeenCalled(); expect(raw.runCommand).not.toHaveBeenCalled();
});