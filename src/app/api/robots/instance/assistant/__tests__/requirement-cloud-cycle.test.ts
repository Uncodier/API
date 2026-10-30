import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { runCloudRequirementCycle } from '../requirement-cloud';
import { runRequirementAssistantSlice } from '../requirement-session';
import { writeRequirementInstanceLog } from '../requirement-instance-log';
import { createSessionStore } from '@/lib/harness/store';
import { MemorySessionStore } from '@/lib/harness/memory-store';
import { createSession } from '@/lib/harness/session';
import { createCloudFileTools } from '@/lib/cloud-files/tools';
import { createCloudFileStore } from '@/lib/cloud-files/store';
import { openWorkspace, adoptRequirementWorkspace } from '@/lib/harness/workspace';
import { buildRequirementProfile } from '@/lib/harness/requirement-profile';
import type { HarnessTool, ToolContext } from '@/lib/harness/types';
import { createRequirementExecutionBoundary } from '../requirement-execution-boundary';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';

jest.mock('../requirement-session', () => ({ runRequirementAssistantSlice: jest.fn() }));
jest.mock('../requirement-instance-log', () => ({ writeRequirementInstanceLog: jest.fn(async () => {}) }));
jest.mock('@/lib/harness/store', () => ({ ...jest.requireActual('@/lib/harness/store'), createSessionStore: jest.fn() }));
jest.mock('@/lib/harness/artifact-store', () => ({ createArtifactStore: jest.fn(() => ({})) }));
jest.mock('@/lib/harness/requirement-tools', () => ({ createRequirementTools: jest.fn(async () => []) }));
jest.mock('@/lib/cloud-files/tools', () => ({ createCloudFileTools: jest.fn() }));
jest.mock('@/lib/cloud-files/store', () => ({ createCloudFileStore: jest.fn() }));
jest.mock('@/app/api/agents/tools/router/screen-access', () => ({ assertToolScreenAccess: jest.fn(async () => {}) }));
jest.mock('@/lib/harness/workspace', () => ({ openWorkspace: jest.fn(), adoptRequirementWorkspace: jest.fn() }));
jest.mock('@/lib/harness/requirement-profile', () => ({ buildRequirementProfile: jest.fn() }));

function fixture() {
  const run = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(),
    runId: randomUUID(), sessionId: randomUUID(), executionGeneration: 1 };
  const store = new MemorySessionStore();
  for (const method of ['create', 'claim', 'load', 'save', 'release', 'assertOwner'] as const) jest.spyOn(store, method);
  jest.mocked(createSessionStore).mockReturnValue(store);
  jest.mocked(assertToolScreenAccess).mockResolvedValue(undefined);
  jest.mocked(createCloudFileTools).mockImplementation(() => [{ name: 'write_cloud_file', description: 'Offline write',
    parameters: {}, execute: async () => ({ success: true }) }] as any);
  jest.mocked(runRequirementAssistantSlice).mockImplementation(async input => {
    await input.assertExecution!();
    return input.store.save({ ...input.session, turns: input.session.turns + 1,
      messages: [...input.session.messages, { role: 'assistant', content: 'Saved offline progress' }] }, run.siteId, input.owner);
  });
  const assertActive = jest.fn(async () => {});
  const getContext = jest.fn(async () => 'Scoped requirement context');
  return { run, store, assertActive, getContext, cycle: () => runCloudRequirementCycle(run, 'Write a document', assertActive, getContext) };
}

beforeEach(() => jest.clearAllMocks());

test('cloud cycle creates a repository-free session and delegates to the canonical assistant without a workspace/profile', async () => {
  const f = fixture();
  const result = await f.cycle();
  expect(result.status).toBe('running');
  expect(result.session).toMatchObject({ id: f.run.sessionId, request: { executionEnvironment: 'cloud', requirementId: f.run.requirementId,
    cloudInstanceId: f.run.instanceId } });
  expect(result.session?.request.repository).toBeUndefined();
  expect(result.session?.request.profile).toBeUndefined();
  expect(result.session?.workspace).toBeUndefined();
  expect(f.store.create).toHaveBeenCalledWith(expect.anything(), { siteId: f.run.siteId, userId: f.run.userId });
  expect(runRequirementAssistantSlice).toHaveBeenCalledWith(expect.objectContaining({ run: f.run, store: f.store, getContext: f.getContext,
    tools: [expect.objectContaining({ name: 'write_cloud_file', effect: 'write' })] }));
  expect(createCloudFileTools).toHaveBeenCalledWith({ siteId: f.run.siteId, userId: f.run.userId,
    instanceId: f.run.instanceId, requirementId: f.run.requirementId }, expect.any(Function), { allowRequirementWrite: true });
  expect(f.store.assertOwner).toHaveBeenCalled();
  expect(f.store.release).toHaveBeenCalledWith(f.run.sessionId, f.run.siteId, expect.any(String));
  expect(openWorkspace).not.toHaveBeenCalled();
  expect(adoptRequirementWorkspace).not.toHaveBeenCalled();
  expect(buildRequirementProfile).not.toHaveBeenCalled();
});

test('continuation retains the same session, requirement binding and durable transcript', async () => {
  const f = fixture();
  await f.cycle();
  f.run.runId = randomUUID();
  const continued = await f.cycle();
  expect(f.store.create).toHaveBeenCalledTimes(1);
  expect(continued.session).toMatchObject({ id: f.run.sessionId, turns: 2 });
  expect(continued.session?.messages.map(message => message.content)).toEqual([
    'Write a document', 'Saved offline progress', 'Saved offline progress',
  ]);
  expect(jest.mocked(runRequirementAssistantSlice).mock.calls[1][0].session.turns).toBe(1);
});

test('write operation UUID is host-owned and stable across retries and cycles, not supplied by model arguments', async () => {
  const f = fixture();
  await f.cycle();
  const tool = jest.mocked(runRequirementAssistantSlice).mock.calls[0][0].tools.find(tool => tool.name === 'write_cloud_file') as HarnessTool;
  const context: ToolContext = { sessionId: f.run.sessionId, operationId: randomUUID(), signal: new AbortController().signal, assertActive: f.assertActive };
  const args = { operation_id: randomUUID(), content: 'Offline document' };
  await tool.execute(args, context);
  await tool.execute({ ...args, operation_id: randomUUID() }, context);
  await f.cycle();
  const next = jest.mocked(runRequirementAssistantSlice).mock.calls[1][0].tools.find(tool => tool.name === 'write_cloud_file') as HarnessTool;
  await next.execute(args, context);
  await next.execute(args, { ...context, operationId: randomUUID() });
  const ids = jest.mocked(createCloudFileTools).mock.calls.flatMap(call => call[2]?.operationId ? [call[2].operationId()] : []);
  expect(ids).toHaveLength(4);
  expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(ids.slice(0, 3)).toEqual([ids[0], ids[0], ids[0]]);
  expect(ids[3]).not.toBe(ids[0]);
  expect(ids).not.toContain(args.operation_id);
});

test.each(['workspace', 'foreign-requirement', 'attached-workspace'])('binding mismatch %s fails closed before claim or execution', async mismatch => {
  const f = fixture();
  const session = createSession({ objective: 'Existing', executionEnvironment: 'cloud' }, f.run.sessionId);
  session.request.requirementId = f.run.requirementId;
  session.request.cloudInstanceId = f.run.instanceId;
  if (mismatch === 'workspace') session.request.executionEnvironment = 'workspace';
  if (mismatch === 'foreign-requirement') session.request.requirementId = randomUUID();
  if (mismatch === 'attached-workspace') session.workspace = { provider: 'vercel', id: randomUUID(), root: '/workspace' };
  jest.mocked(f.store.load).mockResolvedValue(session);
  await expect(f.cycle()).rejects.toThrow('requires reconciliation');
  expect(f.store.claim).not.toHaveBeenCalled();
  expect(runRequirementAssistantSlice).not.toHaveBeenCalled();
  expect(createCloudFileTools).not.toHaveBeenCalled();
});

test('an unclaimed cycle cannot execute tools or inference', async () => {
  const f = fixture();
  jest.mocked(f.store.claim).mockResolvedValue(null);
  expect((await f.cycle()).status).toBe('not_claimed');
  expect(runRequirementAssistantSlice).not.toHaveBeenCalled();
  expect(createCloudFileTools).not.toHaveBeenCalled();
});

test('archived runner replacement cannot adopt a cloud session pinned to the previous instance', async () => {
  const f = fixture();
  await f.cycle();
  const original = await f.store.load(f.run.sessionId, f.run.siteId);
  f.run.instanceId = randomUUID();
  jest.clearAllMocks();
  await expect(f.cycle()).rejects.toThrow('requires reconciliation');
  expect(f.store.claim).not.toHaveBeenCalled();
  expect(runRequirementAssistantSlice).not.toHaveBeenCalled();
  expect(createCloudFileTools).not.toHaveBeenCalled();
  expect(await f.store.load(f.run.sessionId, f.run.siteId)).toEqual(original);
});

test.each(['applied', 'unknown', 'conflict'] as const)('cloud reconciliation uses the original operation journal identity: %s', async state => {
  const f = fixture();
  const content = 'Durable document body omitted from recovery receipts';
  const receipt = { state: state === 'conflict' ? 'conflict' : 'created', file_id: randomUUID(), version: 3, content };
  const readOperation = jest.fn(async () => state === 'unknown' ? null : receipt);
  jest.mocked(createCloudFileStore).mockReturnValue({ readOperation } as any);
  let result: unknown;
  let operationId: string | undefined;
  // Execute and reconcile while the canonical runner still owns the lease.
  jest.mocked(runRequirementAssistantSlice).mockImplementation(async input => {
    const tool = input.tools.find(tool => tool.name === 'write_cloud_file')!;
    const context: ToolContext = { sessionId: f.run.sessionId, operationId: randomUUID(), signal: input.signal,
      assertActive: f.assertActive };
    await tool.execute({ content: 'Draft' }, context);
    operationId = jest.mocked(createCloudFileTools).mock.calls.at(-1)![2]!.operationId!();
    const dispatchCount = jest.mocked(createCloudFileTools).mock.calls.length;
    result = await tool.reconcile!({ operation_id: randomUUID(), content: 'Draft' }, context);
    expect(createCloudFileTools).toHaveBeenCalledTimes(dispatchCount);
    return input.session;
  });
  await f.cycle();
  expect(readOperation).toHaveBeenCalledWith({ siteId: f.run.siteId, userId: f.run.userId,
    instanceId: f.run.instanceId, requirementId: f.run.requirementId }, operationId);
  expect(assertToolScreenAccess).toHaveBeenCalledTimes(2);
  expect(assertToolScreenAccess).toHaveBeenCalledWith('read_cloud_file', { siteId: f.run.siteId, userId: f.run.userId,
    instanceId: f.run.instanceId, requirementId: f.run.requirementId });
  expect(result).toEqual(state === 'unknown' ? { state: 'unknown' } : expect.objectContaining({
    state: 'applied', proof: `cloud-operation:${operationId}`, result: expect.objectContaining({ ok: state !== 'conflict' }),
  }));
  expect(JSON.stringify(result)).not.toContain(content);
  if (state === 'conflict') expect(result).toMatchObject({ result: { error: { effectStarted: false, code: 'conflict' } } });
});

test.each(['before', 'after'] as const)('reconciliation permission denied %s journal lookup never returns metadata or dispatches another write', async phase => {
  const f = fixture();
  const readOperation = jest.fn(async () => ({ state: 'created', file_id: randomUUID(), version: 1, content: 'Private source' }));
  jest.mocked(createCloudFileStore).mockReturnValue({ readOperation } as any);
  const denied = Object.assign(new Error('Offline assets permission denied'), { status: 403 });
  if (phase === 'before') jest.mocked(assertToolScreenAccess).mockRejectedValueOnce(denied);
  else jest.mocked(assertToolScreenAccess).mockResolvedValueOnce(undefined).mockRejectedValueOnce(denied);
  let rejection: unknown;
  jest.mocked(runRequirementAssistantSlice).mockImplementation(async input => {
    const tool = input.tools.find(tool => tool.name === 'write_cloud_file')!;
    try {
      await tool.reconcile!({}, { sessionId: input.session.id, operationId: randomUUID(), signal: input.signal, assertActive: f.assertActive });
    } catch (error) { rejection = error; }
    return input.session;
  });
  await f.cycle();
  expect(rejection).toBe(denied);
  expect(readOperation).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
  expect(createCloudFileTools).toHaveBeenCalledTimes(1); // catalog only; no write dispatch
});

test('canonical execution failure preserves the session, releases ownership and never logs credential details', async () => {
  const f = fixture();
  const secret = randomBytes(32).toString('hex');
  jest.mocked(runRequirementAssistantSlice).mockRejectedValue(new Error(`Bearer ${secret}`));
  expect(await f.cycle()).toMatchObject({ status: 'waiting', session: { id: f.run.sessionId, reason: 'cloud_runtime_unavailable' } });
  expect(f.store.release).toHaveBeenCalledTimes(1);
  expect(writeRequirementInstanceLog).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(jest.mocked(writeRequirementInstanceLog).mock.calls)).not.toContain(secret);
  expect(JSON.stringify(await f.store.load(f.run.sessionId, f.run.siteId))).not.toContain(secret);
});

test('direct cloud catalog descriptors dispatch through the canonical boundary exactly once with the host operation UUID', async () => {
  const f = fixture();
  const originalCallId = randomUUID();
  const args = { action: 'create', name: 'notes.md', content: 'Private offline document' };
  const receipt = { ok: true, output: { file_id: randomUUID(), version: 1 } };
  const write = jest.fn(async (_scope: unknown, _input: unknown) => receipt);
  jest.mocked(createCloudFileStore).mockReturnValue({ write } as any);
  jest.mocked(createCloudFileTools).mockImplementation((scope, assertActive, options) =>
    ['read_cloud_file', 'list_cloud_files', 'write_cloud_file'].map(name => ({ name, description: name, parameters: {},
      execute: async (input: any) => {
        await assertActive();
        if (name !== 'write_cloud_file') throw new Error('Unexpected cloud read');
        return createCloudFileStore().write(scope, { ...input, operation_id: options!.operationId!() });
      },
    })) as any);
  const { routeTools } = loadRuntimeModule<typeof import('@/app/api/agents/tools/router/assistantProtocol')>(
    'src/app/api/agents/tools/router/assistantProtocol.ts', {
      '@/lib/services/embeddings-service': {},
      './screen-access': { loadToolScreenAccess: async () => ({ isAdmin: true, blockedScreens: [] }),
        canUseToolScreen: () => true, assertToolScopeArgs: () => {}, guardToolScreen: (tool: unknown) => tool },
    });
  jest.mocked(runRequirementAssistantSlice).mockImplementation(async input => {
    const adapter = createRequirementExecutionBoundary({ ...input, assertActive: input.assertExecution,
      writeLog: async () => {}, artifacts: {
        reserve: async () => {},
        put: async (_session, _site, _owner, id, text) => ({ id, chars: text.length, bytes: Buffer.byteLength(text) }),
        read: async () => null,
      } });
    await adapter.initialize();
    // These are the same host wrapper descriptors built by requirement-session.ts.
    const wrappers = input.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
      execute: (value: any) => adapter.executeHarnessTool(tool.name, value) }));
    const routed = routeTools([...wrappers, { name: 'offline_unrelated', description: '', parameters: {}, execute: async () => ({}) }],
      { siteId: f.run.siteId, userId: f.run.userId });
    const cloudNames = ['read_cloud_file', 'list_cloud_files', 'write_cloud_file'];
    for (const name of cloudNames) expect(routed.filter(tool => tool.name === name)).toHaveLength(1);
    const router = routed.find(tool => tool.name === 'tools')!;
    const listing = await router.execute({ action: 'list' });
    for (const name of cloudNames) {
      expect(listing.tools.map((tool: any) => tool.name)).not.toContain(name);
      expect(await router.execute({ action: 'call', name, args: JSON.stringify(args) })).toMatchObject({ success: false });
    }
    expect(write).not.toHaveBeenCalled();
    await adapter.boundary.beforeModel({ system: 'Offline canonical turn', messages: adapter.getMessages(), tools: routed, maxOutputTokens: 100 });
    await adapter.boundary.onModelMessage({ role: 'assistant', content: '', tool_calls: [{ id: originalCallId, type: 'function',
      function: { name: 'write_cloud_file', arguments: JSON.stringify(args) } }] });
    const direct = routed.find(tool => tool.name === 'write_cloud_file')!;
    const callback = jest.fn(() => direct.execute(args));
    expect(await adapter.boundary.executeTool({ id: originalCallId, name: 'write_cloud_file', args }, callback)).toEqual(receipt);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(adapter.getSession().pending).toBeUndefined();
    expect(adapter.getSession().messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: originalCallId });
    await adapter.boundary.afterTurn([]);
    return adapter.getSession();
  });
  expect((await f.cycle()).status).toBe('running');
  const hash = createHash('sha256').update(`${f.run.sessionId}:${originalCallId}`).digest('hex');
  const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith({ siteId: f.run.siteId, userId: f.run.userId, instanceId: f.run.instanceId,
    requirementId: f.run.requirementId }, { ...args, operation_id: operationId });
  expect(openWorkspace).not.toHaveBeenCalled();
});