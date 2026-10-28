import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { registerSandboxBilling, reconcileSandboxBilling } from '@/lib/services/billing/sandbox-billing';
import { openAssistantWorkspace } from '../workspace-provider';
import { WORKSPACE_ISOLATION_VERSION, WORKSPACE_ROOT_INIT } from '@/lib/harness/workspace-process-guard';
import { createWorkspaceTools } from '@/lib/harness/workspace-tools';

jest.mock('@vercel/sandbox', () => ({ Sandbox: { get: jest.fn(), create: jest.fn() } }));
jest.mock('@/lib/harness/sandbox-auth', () => ({ resolveSandboxAuth: () => ({}) }));
jest.mock('@/lib/services/billing/sandbox-billing', () => ({
  registerSandboxBilling: jest.fn(async () => {}), reconcileSandboxBilling: jest.fn(async () => {}),
  reconcileSandboxBillingQuiet: jest.fn(async () => true), SandboxBillingError: class extends Error {},
}));
const scope = { instanceId: randomUUID(), siteId: randomUUID(), userId: randomUUID() };
const sourceId = `h-${randomUUID()}`, snapshotId = randomUUID();
const ownedName = `a-${scope.instanceId}`;
const inspectName = `ai-${createHash('sha256').update(JSON.stringify([scope.instanceId, snapshotId])).digest('hex').slice(0, 40)}`;
let owned: any, original: any;
let assertActive: jest.Mock, recordResource: jest.Mock, assertCleanup: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  assertActive = jest.fn(async () => {}); recordResource = jest.fn(async () => {});
  assertCleanup = jest.fn(async () => {});
  owned = { name: ownedName, status: 'running', persistent: true,
    tags: { assistantInstance: scope.instanceId, assistantSite: scope.siteId, harnessIsolation: WORKSPACE_ISOLATION_VERSION,
      assistantSourceSnapshot: 'empty', assistantReady: 'true' },
    runCommand: jest.fn(async () => ({ exitCode: 0 })), update: jest.fn(async () => {}), stop: jest.fn(async () => {}),
    currentSnapshotId: randomUUID() };
  original = { name: sourceId, currentSnapshotId: snapshotId, status: 'stopped', tags: { harnessIsolation: WORKSPACE_ISOLATION_VERSION },
    runCommand: jest.fn(), stop: jest.fn(), update: jest.fn(), snapshot: jest.fn() };
  (Sandbox.get as jest.Mock).mockImplementation(async ({ name }) => name === sourceId ? original : owned);
  (Sandbox.create as jest.Mock).mockImplementation(async ({ name, tags }) => { owned.name = name; owned.tags = tags; return owned; });
});
const open = (requirement = false, initialized = false) => openAssistantWorkspace({ scope,
  source: requirement ? { kind: 'requirement', requirementId: randomUUID(), sandboxName: sourceId } : { kind: 'instance' },
  initialized, assertActive, assertCleanup, recordResource, signal: new AbortController().signal });

it('reconnects an existing private workspace without clearing or cloning files', async () => {
  const result = await open(false, true);
  expect(result.workspace.ref.id).toBe(ownedName);
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(owned.runCommand).not.toHaveBeenCalled();
  expect(owned.update).not.toHaveBeenCalled();
  expect(registerSandboxBilling).toHaveBeenCalledWith(ownedName, { kind: 'instance', id: scope.instanceId, siteId: scope.siteId });
  expect(recordResource).toHaveBeenCalledWith(ownedName);
  await result.close();
  expect(owned.stop).not.toHaveBeenCalled(); // Background work keeps its bounded provider lifetime.
});

it('initializes an empty workspace lazily without git, requirement or inherited environment', async () => {
  (Sandbox.get as jest.Mock).mockRejectedValueOnce({ response: { status: 404 } });
  await open();
  expect(Sandbox.create).toHaveBeenCalledWith(expect.objectContaining({ name: ownedName, persistent: true,
    image: 'vercel/sandbox/universal', env: {}, ports: [], timeout: 180000 }));
  expect((Sandbox.create as jest.Mock).mock.calls[0][0]).not.toHaveProperty('source');
  expect((Sandbox.create as jest.Mock).mock.calls[0][0]).toMatchObject({ snapshotExpiration: 0, keepLastSnapshots: { count: 1, expiration: 0 } });
  expect(owned.runCommand).toHaveBeenCalledWith(expect.objectContaining({ args: ['-I', '-S', '-c', WORKSPACE_ROOT_INIT] }));
  expect(reconcileSandboxBilling).toHaveBeenCalled();
});

it('inspects only an exact saved snapshot, never resumes/stops/executes on the source', async () => {
  (Sandbox.get as jest.Mock).mockImplementation(async ({ name, resume }) => {
    if (name === sourceId) { expect(resume).toBe(false); return original; }
    if (!resume) throw { response: { status: 404 } };
    return owned;
  });
  const result = await open(true);
  expect(Sandbox.create).toHaveBeenCalledWith(expect.objectContaining({ name: inspectName,
    source: { type: 'snapshot', snapshotId }, env: {}, ports: [], networkPolicy: 'deny-all' }));
  expect((Sandbox.create as jest.Mock).mock.calls[0][0]).not.toHaveProperty('image');
  expect(owned.runCommand).not.toHaveBeenCalled(); // No chown, init or source scripts.
  expect(result.source).toMatchObject({ kind: 'requirement_snapshot', snapshotId });
  await result.close();
  expect(owned.stop).toHaveBeenCalledTimes(1);
  for (const fn of [original.runCommand, original.stop, original.update, original.snapshot]) expect(fn).not.toHaveBeenCalled();
});

it('cannot reach arbitrary exec/patch through the readonly adapter even outside the catalog', async () => {
  owned.name = inspectName; owned.tags.assistantSourceSnapshot = snapshotId;
  const { workspace } = await open(true);
  await expect(workspace.exec({ command: 'echo no' })).rejects.toMatchObject({ code: 'WORKSPACE_READ_ONLY', effectStarted: false });
  await expect(workspace.writeFile('file.md', 'no')).rejects.toMatchObject({ code: 'WORKSPACE_READ_ONLY' });
  const patch = createWorkspaceTools(workspace).find(tool => tool.name === 'apply_patch')!;
  expect(await patch.execute({ changes: [{ operation: 'create', path: 'file.md', content: 'no' }] },
    { sessionId: scope.instanceId, operationId: randomUUID(), signal: new AbortController().signal, assertActive }))
    .toMatchObject({ ok: false });
  expect(owned.runCommand).not.toHaveBeenCalled();
});

it.each([401, 403, 503])('never creates a replacement after provider HTTP %d', async status => {
  (Sandbox.get as jest.Mock).mockRejectedValue({ response: { status } });
  await expect(open()).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
  expect(Sandbox.create).not.toHaveBeenCalled();
});

it('does not replace a missing previously initialized workspace with an empty VM', async () => {
  (Sandbox.get as jest.Mock).mockRejectedValue({ response: { status: 404 } });
  await expect(open(false, true)).rejects.toMatchObject({ code: 'WORKSPACE_MISSING' });
  expect(Sandbox.create).not.toHaveBeenCalled();
});

it('preserves a missing source snapshot instead of falling back to a fresh image', async () => {
  original.currentSnapshotId = undefined;
  await expect(open(true)).rejects.toMatchObject({ code: 'WORKSPACE_SNAPSHOT_UNAVAILABLE' });
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(registerSandboxBilling).not.toHaveBeenCalled();
});

it('does not relabel an unisolated legacy filesystem as trusted code', async () => {
  original.tags = {};
  await expect(open(true)).rejects.toMatchObject({ code: 'WORKSPACE_ISOLATION_REQUIRED' });
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(original.runCommand).not.toHaveBeenCalled();
});

it('rejects a foreign identity without stopping or modifying it', async () => {
  owned.tags.assistantInstance = randomUUID();
  await expect(open()).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_MISMATCH' });
  expect(owned.stop).not.toHaveBeenCalled();
  expect(owned.update).not.toHaveBeenCalled();
});

it('does not disclose provider credentials on errors', async () => {
  const secrets = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')];
  const url = new URL('https://sandbox.example.invalid'); url.username = secrets[0]; url.password = secrets[1];
  (Sandbox.get as jest.Mock).mockRejectedValue(new Error(url.href));
  const error = await open().catch(value => value);
  for (const value of secrets) expect(String(error)).not.toContain(value);
});

it('never stops an inspection after its resource lease passed to another owner', async () => {
  owned.name = inspectName; owned.tags.assistantSourceSnapshot = snapshotId;
  const result = await open(true);
  assertCleanup.mockRejectedValueOnce(new Error('Lease lost'));
  await expect(result.close()).rejects.toThrow('Lease lost');
  expect(owned.stop).not.toHaveBeenCalled();
});