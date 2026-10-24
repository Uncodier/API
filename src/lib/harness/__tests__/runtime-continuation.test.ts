import { randomBytes, randomUUID } from 'node:crypto';
import { createMemorySessionStore } from '../memory-store';
import { createMemoryHostStateStore } from '../host-state-store';
import { createMemoryArtifactStore } from '../artifact-store';
import { createSession, sessionRequestSchema } from '../session';
import { createRedactor } from '../security';
import { loadSessionConfiguration } from '../host-configuration';
import type { HarnessSession, Workspace } from '../types';

let store = createMemorySessionStore();
let encryptionKey = randomBytes(32).toString('hex');
const open = jest.fn(); const replace = jest.fn(); const engine = jest.fn();
const capability = jest.fn(); const profile = jest.fn(); const refresh = jest.fn();
const cleanupClaim = jest.fn(); const suspendCleanup = jest.fn();
jest.mock('@/lib/services/billing/sandbox-cleanup-fence', () => ({ claimSandboxCleanup: (...args: unknown[]) => cleanupClaim(...args) }));
jest.mock('../store', () => ({ ...jest.requireActual('../store'), createSessionStore: () => store }));
jest.mock('../host-state-store', () => ({ ...jest.requireActual('../host-state-store'), createHostStateStore: () => createMemoryHostStateStore(store, encryptionKey) }));
jest.mock('../artifact-store', () => ({ ...jest.requireActual('../artifact-store'), createArtifactStore: () => createMemoryArtifactStore(store) }));
jest.mock('../workspace', () => ({ openWorkspace: (...args: unknown[]) => open(...args), replaceWorkspaceEnvironment: (...args: unknown[]) => replace(...args),
  suspendWorkspaceForCleanup: (...args: unknown[]) => suspendCleanup(...args) }));
jest.mock('../workspace-tools', () => ({ createWorkspaceTools: () => [] }));
jest.mock('./retired/engine', () => ({ runSessionSlice: (...args: unknown[]) => engine(...args) }));
jest.mock('./retired/model', () => ({ createHarnessModel: () => ({}) }));
jest.mock('../capabilities', () => ({ createCapabilityTools: (...args: unknown[]) => capability(...args), refreshTenantEnvironment: (...args: unknown[]) => refresh(...args) }));
jest.mock('../delivery-tools', () => ({ createDeliveryTools: () => [] }));
jest.mock('../archive-tool', () => ({ createArchiveTool: () => [] }));
jest.mock('../profile', () => ({ resolveHostProfile: (...args: unknown[]) => profile(...args) }));
import { executeSessionSlice } from './retired/runtime';

it.each(['WORKSPACE_AUTHORIZATION_REQUIRED', 'WORKSPACE_PROVIDER_BILLING_REQUIRED', 'WORKSPACE_AUTH_CONFIGURATION_REQUIRED'])('pauses %s before model dispatch and does not auto-retry the same session', async code => {
  open.mockRejectedValue(Object.assign(new Error('Sandbox access requires operator attention.'), { name: 'WorkspaceError', code }));
  const result = await executeSessionSlice(session.id, scope);
  expect(result).toEqual({ status: 'paused', continue: false });
  const saved = await store.load(session.id, scope.siteId);
  expect(saved?.reason).toContain('workspace_access_requires_operator:');
  expect(saved?.turns).toBe(0); expect(engine).not.toHaveBeenCalled();
  expect(await executeSessionSlice(session.id, scope)).toEqual({ status: 'not_claimed', continue: false });
  expect(open).toHaveBeenCalledTimes(1);
});

const scope = { siteId: randomUUID(), userId: randomUUID() };
let session: HarnessSession;
let currentEnvironment: Record<string, string>;
beforeEach(async () => {
  jest.clearAllMocks(); store = createMemorySessionStore(); encryptionKey = randomBytes(32).toString('hex');
  session = createSession(sessionRequestSchema.parse({ objective: 'Continue project', repository: { url: 'https://repo.example.invalid/project.git' }, limits: { maxActiveMs: 60000 } }));
  await store.create(session, scope);
  profile.mockReturnValue({ ...scope, allowed: [], environment: { APP_SETTING: 'retained' } });
  capability.mockResolvedValue([]);
  cleanupClaim.mockReset().mockResolvedValue(null); suspendCleanup.mockReset().mockResolvedValue(undefined);
  replace.mockImplementation(async (_workspace, values) => { currentEnvironment = values; });
  open.mockImplementation(async input => {
    await input.assertActive(); currentEnvironment = input.host.environment;
    return { ref: { provider: 'vercel', id: `h-${session.id}`, root: '/vercel/sandbox' } } as Workspace;
  });
  engine.mockImplementation(async input => input.session);
});

it('provisions once, merges profile values, reopens and keeps both current and rotated secret redaction', async () => {
  const oldToken = randomBytes(24).toString('hex'); const newToken = randomBytes(24).toString('hex');
  let runs = 0;
  engine.mockImplementation(async input => {
    runs++;
    const options = capability.mock.calls.at(-1)![0];
    if (runs === 1) await options.saveEnvironment('tenant', { TENANT_APP_TOKEN: oldToken }, { expiresAt: new Date(Date.now() + 3600000).toISOString() });
    if (runs === 2) {
      expect(currentEnvironment).toEqual({ APP_SETTING: 'retained', TENANT_APP_TOKEN: oldToken });
      expect(input.redact(oldToken)).not.toContain(oldToken);
      await options.saveEnvironment('tenant', { TENANT_APP_TOKEN: newToken }, { expiresAt: new Date(Date.now() + 3600000).toISOString() });
    }
    if (runs === 3) {
      expect(currentEnvironment).toEqual({ APP_SETTING: 'retained', TENANT_APP_TOKEN: newToken });
      for (const token of [oldToken, newToken]) expect(input.redact(token)).not.toContain(token);
      expect(open.mock.calls.at(-1)![0].host.redactionValues).toEqual(expect.arrayContaining([oldToken, newToken]));
    }
    return input.session;
  });
  await executeSessionSlice(session.id, scope); await executeSessionSlice(session.id, scope); await executeSessionSlice(session.id, scope);
  expect(runs).toBe(3); expect(refresh).not.toHaveBeenCalled();
  const snapshot = await store.load(session.id, scope.siteId);
  for (const token of [oldToken, newToken]) expect(JSON.stringify(snapshot)).not.toContain(token);
});

it('accounts failed setup time and never opens a workspace once total active budget is exhausted', async () => {
  let time = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => time);
  open.mockImplementation(async input => { await input.assertActive(); time += 20000; throw new Error('Synthetic clone failure'); });
  try {
    for (let n = 0; n < 3; n++) {
      await executeSessionSlice(session.id, scope);
      expect((await store.load(session.id, scope.siteId))!.activeMs).toBe((n + 1) * 20000);
      await store.control(session.id, scope.siteId, 'resume');
    }
    expect((await executeSessionSlice(session.id, scope)).status).toBe('paused');
    expect(open).toHaveBeenCalledTimes(3);
  } finally { jest.restoreAllMocks(); }
});

it('checks session ownership after async preparation before allowing the next SDK effect', async () => {
  let writes = 0;
  open.mockImplementation(async input => {
    await input.assertActive();
    await store.control(session.id, scope.siteId, 'cancel');
    await input.assertActive(); writes++;
  });
  await executeSessionSlice(session.id, scope);
  expect(writes).toBe(0); expect((await store.load(session.id, scope.siteId))!.status).toBe('cancelled');
});

it('suspends only after an atomic current-owner idle claim and finishes confirmed stop', async () => {
  const fence = { assert: jest.fn(), finish: jest.fn() };
  cleanupClaim.mockResolvedValue(fence);
  await executeSessionSlice(session.id, scope);
  expect(cleanupClaim).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id, siteId: scope.siteId, resource: `h-${session.id}` }));
  expect(suspendCleanup).toHaveBeenCalledWith(expect.objectContaining({ ref: expect.any(Object) }), fence.assert);
  expect(fence.finish).toHaveBeenCalledTimes(1);
});
it('never stops a resumed successor when the atomic owner claim refuses', async () => {
  engine.mockImplementation(async input => {
    await store.control(session.id, scope.siteId, 'pause');
    await store.control(session.id, scope.siteId, 'resume');
    await store.claim(session.id, scope.siteId, 'successor', 180);
    return input.session;
  });
  cleanupClaim.mockResolvedValue(null);
  await executeSessionSlice(session.id, scope);
  expect(suspendCleanup).not.toHaveBeenCalled();
  await expect(store.assertOwner(session.id, scope.siteId, 'successor', 180)).resolves.toBeUndefined();
});
it('retains cleanup claim on unknown stop, rather than admitting a resumed resource', async () => {
  const fence = { assert: jest.fn(), finish: jest.fn() };
  cleanupClaim.mockResolvedValue(fence); suspendCleanup.mockRejectedValue(new Error('unknown stop'));
  await executeSessionSlice(session.id, scope);
  expect(fence.finish).not.toHaveBeenCalled();
});
it('cleans an owned reused VM after opening billing failure even when no workspace adapter returned', async () => {
  const handle={name:`h-${session.id}`,stop:jest.fn().mockResolvedValue(undefined)};
  const fence={assert:jest.fn().mockResolvedValue(undefined),finish:jest.fn().mockResolvedValue(undefined)};
  cleanupClaim.mockResolvedValue(fence);
  open.mockImplementation(async input=>{input.onOwnedHandle(handle);throw new Error('billing unavailable');});
  await executeSessionSlice(session.id,scope);
  expect(handle.stop).toHaveBeenCalledTimes(1);expect(fence.finish).toHaveBeenCalledTimes(1);
  expect(engine).not.toHaveBeenCalled();expect((await store.load(session.id,scope.siteId))?.status).toBe('waiting');
});

it('restores encrypted configuration through independent host-store instances with no session plaintext', async () => {
  const secret = randomBytes(24).toString('hex');
  await store.claim(session.id, scope.siteId, 'host', 180);
  const first = await loadSessionConfiguration(createMemoryHostStateStore(store, encryptionKey), { id: session.id, siteId: scope.siteId, owner: 'host' });
  await first.setLayer('profile', { values: { APP_SETTING: 'retained' } });
  await first.setLayer('db', { values: { DB_PASSWORD: secret } });
  const second = await loadSessionConfiguration(createMemoryHostStateStore(store, encryptionKey), { id: session.id, siteId: scope.siteId, owner: 'host' });
  expect(second.values()).toEqual({ APP_SETTING: 'retained', DB_PASSWORD: secret });
  expect(createRedactor(second.configuration.redactionValues)(secret)).not.toContain(secret);
  expect(JSON.stringify(await store.load(session.id, scope.siteId))).not.toContain(secret);
});

it('runs the actual engine across a provisioning slice and the next execution without reprovisioning', async () => {
  const actualEngine = jest.requireActual('./retired/engine').runSessionSlice;
  const token = randomBytes(24).toString('hex');
  let time = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => time);
  let provisionCalls = 0; let modelCalls = 0;
  capability.mockImplementation(async options => [{ name: 'provision', effect: 'write', description: '', parameters: {},
    execute: async () => {
      provisionCalls++;
      await options.saveEnvironment('tenant', { TENANT_APP_TOKEN: token }, { expiresAt: new Date(time + 3600000).toISOString() });
      time += 60001;
      return { ok: true, output: { configured: true } };
    } }]);
  engine.mockImplementation(async input => actualEngine({ ...input, now: () => time,
    model: { respond: async () => {
      modelCalls++;
      if (modelCalls === 1) return { finishReason: 'tool_calls', message: { role: 'assistant', content: '',
        toolCalls: [{ id: 'provision', name: 'provision', arguments: '{}' }] } };
      expect(currentEnvironment).toEqual({ APP_SETTING: 'retained', TENANT_APP_TOKEN: token });
      expect(input.redact(token)).not.toContain(token);
      return { finishReason: 'tool_calls', message: { role: 'assistant', content: '', toolCalls: [{ id: 'finish', name: 'finish_task',
        arguments: JSON.stringify({ summary: 'Application environment retained across continuation.', outcome: 'implemented' }) }] } };
    } },
  }));
  try {
    // Use a task budget larger than the artificial first transport slice.
    const longer = createSession(sessionRequestSchema.parse({ objective: 'Provision then continue', repository: session.request.repository, limits: { maxActiveMs: 300000 } }));
    await store.create(longer, scope); session = longer;
    expect((await executeSessionSlice(session.id, scope)).continue).toBe(true);
    expect((await executeSessionSlice(session.id, scope)).status).toBe('completed');
    expect(provisionCalls).toBe(1); expect(modelCalls).toBe(2);
    expect(JSON.stringify(await store.load(session.id, scope.siteId))).not.toContain(token);
  } finally { jest.restoreAllMocks(); }
});

it('refreshes expired tenant credentials host-side and retains old values for redaction', async () => {
  const requirementId = randomUUID(); const previous = randomBytes(24).toString('hex'); const current = randomBytes(24).toString('hex');
  profile.mockReturnValue({ ...scope, requirementId, allowed: [], environment: { APP_SETTING: 'retained' } });
  await store.claim(session.id, scope.siteId, 'prepare', 180);
  const host = await loadSessionConfiguration(createMemoryHostStateStore(store, encryptionKey), { id: session.id, siteId: scope.siteId, owner: 'prepare' });
  await host.setLayer('tenant', { values: { SUPABASE_JWT: previous, APPS_TENANT_JWT: previous, SUPABASE_SCHEMA: 'app_test' },
    expiresAt: new Date(Date.now() - 1000).toISOString(), refresh: { kind: 'tenant', requirementId } });
  await store.release(session.id, scope.siteId, 'prepare');
  refresh.mockResolvedValue({ values: { SUPABASE_JWT: current, APPS_TENANT_JWT: current }, expiresAt: new Date(Date.now() + 900000).toISOString() });
  engine.mockImplementation(async input => {
    expect(currentEnvironment).toEqual({ APP_SETTING: 'retained', SUPABASE_SCHEMA: 'app_test', SUPABASE_JWT: current, APPS_TENANT_JWT: current });
    for (const value of [previous, current]) expect(input.redact(value)).not.toContain(value);
    return input.session;
  });
  await executeSessionSlice(session.id, scope);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('does not prevent repository work when refreshing an optional DB is unavailable', async () => {
  const requirementId = randomUUID(); const previous = randomBytes(24).toString('hex');
  profile.mockReturnValue({ ...scope, requirementId, allowed: [], environment: { APP_SETTING: 'retained' } });
  await store.claim(session.id, scope.siteId, 'prepare', 180);
  const host = await loadSessionConfiguration(createMemoryHostStateStore(store, encryptionKey), { id: session.id, siteId: scope.siteId, owner: 'prepare' });
  await host.setLayer('tenant', { values: { SUPABASE_JWT: previous, SUPABASE_SCHEMA: 'app_test' },
    expiresAt: new Date(Date.now() - 1000).toISOString(), refresh: { kind: 'tenant', requirementId } });
  await store.release(session.id, scope.siteId, 'prepare');
  refresh.mockRejectedValue(new Error('Temporary provider outage'));
  expect((await executeSessionSlice(session.id, scope)).continue).toBe(true);
  expect(engine).toHaveBeenCalledTimes(1);
  expect(currentEnvironment).toEqual({ APP_SETTING: 'retained', SUPABASE_SCHEMA: 'app_test' });
  expect(open.mock.calls[0][0].host.redactionValues).toContain(previous);
});