import { randomBytes, randomUUID } from 'node:crypto';
import { runSessionSlice } from './retired/engine';
import { createSession, sessionRequestSchema } from '../session';
import { createMemorySessionStore } from '../memory-store';
import { createMemoryArtifactStore } from '../artifact-store';
import { retryModelAdmission } from '../model-admission';
import { sourceExportRisk } from '../export-policy';
import { BeforeEffectError } from '../security';
import { createWorkspaceTools } from '../workspace-tools';
import { WorkspaceError } from '../workspace';
import type { HarnessTool, ModelReply, Workspace } from '../types';
jest.mock('@vercel/sandbox', () => ({ Sandbox: {} }));

const scope = { siteId: randomUUID(), userId: randomUUID() };
const call = (id: string, name: string, args: Record<string, unknown> = {}): ModelReply => ({
  message: { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] }, finishReason: 'tool_calls',
});
const finish = () => call('finish', 'finish_task', { summary: 'Actual checks reported.', outcome: 'implemented' });
async function setup(tools: HarnessTool[], replies: ModelReply[]) {
  const store = createMemorySessionStore();
  const initial = createSession(sessionRequestSchema.parse({ objective: 'Repair task', repository: { url: 'https://repo.example.invalid/app.git' }, limits: { maxOutputTokens: 256, maxTotalTokens: 10000000 } }));
  await store.create(initial, scope);
  const session = (await store.claim(initial.id, scope.siteId, 'worker', 180))!;
  const artifacts = createMemoryArtifactStore(store);
  return { store, session, artifacts, owner: 'worker', siteId: scope.siteId,
    model: { respond: jest.fn(async () => { const reply = replies.shift(); if (!reply) throw new Error('No scripted response'); return reply; }) },
    tools, workspace: { ref: { provider: 'vercel', id: 'workspace', root: '/vercel/sandbox' } } as Workspace };
}

it('reconciles a parameterless uncertain provision by trusted adapter evidence and permits a fresh attempt', async () => {
  const execute = jest.fn().mockResolvedValueOnce({ ok: false, error: { code: 'TRANSPORT', message: 'Unknown outcome', ambiguous: true } }).mockResolvedValue({ ok: true });
  const reconcile = jest.fn().mockResolvedValue({ state: 'not_applied', proof: 'provider-receipt-operation-1-absent' });
  const input = await setup([{ name: 'provision', effect: 'write', description: '', parameters: {}, execute, reconcile }], [
    call('provision-1', 'provision'), call('check', 'reconcile_operation', { operationId: 'provision-1' }), call('provision-2', 'provision'), finish(),
  ]);
  const result = await runSessionSlice(input);
  expect(result.status).toBe('completed'); expect(execute).toHaveBeenCalledTimes(2);
  expect(reconcile.mock.calls[0][1].operationId).toBe('provision-1');
});

it('uses the same normalized arguments for effect identity, execution and trusted reconciliation', async () => {
  const execute = jest.fn().mockResolvedValueOnce({ ok: false, error: { code: 'TRANSPORT', message: 'Unknown', ambiguous: true } }).mockResolvedValue({ ok: true });
  const reconcile = jest.fn().mockResolvedValue({ state: 'not_applied', proof: 'offline-provider-proof' });
  const input = await setup([{ name: 'normalized_write', effect: 'write', description: '', parameters: {}, execute, reconcile,
    normalizeArguments: args => ({ query: String(args.query).trim() }) }], [
    call('first', 'normalized_write', { query: ' research ' }),
    call('check', 'reconcile_operation', { operationId: 'first' }),
    call('retry', 'normalized_write', { query: '\tresearch\n' }), finish(),
  ]);
  const result = await runSessionSlice(input);
  expect(result.status).toBe('completed');
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls.map(args => args[0])).toEqual([{ query: 'research' }, { query: 'research' }]);
  expect(reconcile.mock.calls[0][0]).toEqual({ query: 'research' });
});

it('never accepts a model assertion as reconciliation and never retries a write already applied', async () => {
  const execute = jest.fn().mockResolvedValue({ ok: false, error: { code: 'TRANSPORT', message: 'Unknown', ambiguous: true } });
  const reconcile = jest.fn().mockResolvedValue({ state: 'applied', proof: 'provider-receipt', result: { ok: true, output: 'already applied' } });
  const input = await setup([{ name: 'publish', effect: 'write', description: '', parameters: {}, execute, reconcile }], [
    call('publish-1', 'publish'), call('fake', 'reconcile_operation', { operationId: 'publish-1', state: 'not_applied' }),
    call('check', 'reconcile_operation', { operationId: 'publish-1' }), call('publish-2', 'publish'), finish(),
  ]);
  const result = await runSessionSlice(input);
  expect(execute).toHaveBeenCalledTimes(1); expect(reconcile).toHaveBeenCalledTimes(1);
  expect(result.messages.find(m => m.toolCallId === 'publish-2')?.content).toContain('already applied');
});

it('does not quarantine a trusted pre-dispatch failure', async () => {
  const execute = jest.fn().mockRejectedValueOnce(new BeforeEffectError('Input could not be prepared; no request sent')).mockResolvedValue({ ok: true });
  const input = await setup([{ name: 'write', effect: 'write', description: '', parameters: {}, execute }], [call('first', 'write'), call('second', 'write'), finish()]);
  const result = await runSessionSlice(input);
  expect(result.uncertainOperations).toEqual([]); expect(execute).toHaveBeenCalledTimes(2);
});

it('reconciles exact workspace patches without replaying a partially applied batch', async () => {
  const files: Record<string, string> = { 'a.txt': 'original' };
  const workspace = { ref: { provider: 'vercel', id: 'w', root: '/vercel/sandbox' },
    readFile: async (path: string) => { if (!(path in files)) throw new WorkspaceError('FILE_NOT_FOUND', 'missing'); return files[path]; },
  } as unknown as Workspace;
  const tool = createWorkspaceTools(workspace).find(tool => tool.name === 'apply_patch')!;
  const context = { sessionId: randomUUID(), operationId: 'patch', signal: new AbortController().signal, assertActive: async () => {} };
  const args = { changes: [{ operation: 'replace', path: 'a.txt', oldText: 'original', newText: 'updated' }, { operation: 'create', path: 'b.txt', content: 'new' }] };
  expect((await tool.reconcile!(args, context)).state).toBe('not_applied');
  files['a.txt'] = 'updated';
  expect((await tool.reconcile!(args, context)).state).toBe('unknown');
  files['b.txt'] = 'new';
  expect((await tool.reconcile!(args, context)).state).toBe('applied');
});

it('retains the complete large escaped result and reads its tail from another artifact-store instance', async () => {
  const marker = `TAIL_${randomBytes(12).toString('hex')}`;
  const output = '\\'.repeat(50000) + marker;
  const input = await setup([{ name: 'read', effect: 'read', description: '', parameters: {}, execute: async () => ({ ok: true, output }) }], [call('read', 'read'), finish()]);
  const result = await runSessionSlice(input);
  const receipt = JSON.parse(result.messages.find(m => m.toolCallId === 'read')!.content);
  expect(receipt.artifact).toBeDefined(); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(20000);
  // Read while owning an independent running session; terminal results remain stored,
  // direct store retrieval is owner-scoped so use running slice below for pagination.
  const next = await setup([{ name: 'read', effect: 'read', description: '', parameters: {}, execute: async () => ({ ok: true, output }) }], [call('read', 'read')]);
  let time = 0; next.model.respond.mockImplementation(async () => { time += 2; return call('read', 'read'); });
  const partial = await runSessionSlice({ ...next, now: () => time, sliceMs: 3 });
  const saved = JSON.parse(partial.messages.find(m => m.toolCallId === 'read')!.content);
  const page = await createMemoryArtifactStore(next.store).read(partial.id, scope.siteId, next.owner, saved.artifact.id, saved.artifact.chars - 100, 100);
  expect(page?.text).toContain(marker);
});

it('reserves serialized space before each write in an escaped 32-call batch', async () => {
  const execute = jest.fn(async () => ({ ok: true, output: '\\'.repeat(50000) }));
  const input = await setup([{ name: 'write', effect: 'write', description: '', parameters: {}, execute }], [finish()]);
  const batch = Array.from({ length: 32 }, (_, n) => ({ id: `w${n}`, name: 'write', arguments: '{}' }));
  const history = Array.from({ length: 147 }, () => ({ role: 'user' as const, content: 'x'.repeat(15900) }));
  input.session = await input.store.save({ ...input.session, messages: [...input.session.messages, ...history,
    { role: 'assistant', content: '', toolCalls: batch }] }, scope.siteId, input.owner);
  const result = await runSessionSlice(input);
  expect(execute).toHaveBeenCalledTimes(32);
  expect(result.messages.filter(m => m.role === 'tool' && m.toolCallId?.startsWith('w'))).toHaveLength(32);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(3900000);
  expect(result.pending).toBeUndefined();
});

describe('provider admission is separate from effects', () => {
  it('retries 429 with Retry-After, then succeeds without touching tools', async () => {
    let now = 0;
    const create = jest.fn().mockRejectedValueOnce({ status: 429, headers: { 'retry-after': '2' } }).mockResolvedValue('accepted');
    const sleep = jest.fn(async (ms: number) => { now += ms; });
    await expect(retryModelAdmission(create, new AbortController().signal, { sleep, now: () => now })).resolves.toBe('accepted');
    expect(sleep.mock.calls[0][0]).toBe(2000); expect(create).toHaveBeenCalledTimes(2);
  });
  it('bounds admission retries and never shortens a Retry-After beyond the retry budget', async () => {
    const create = jest.fn().mockRejectedValue({ status: 503 });
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(retryModelAdmission(create, new AbortController().signal, { sleep })).rejects.toMatchObject({ status: 503 });
    expect(create).toHaveBeenCalledTimes(3);
    const later = jest.fn().mockRejectedValue({ status: 429, headers: { 'retry-after': '30' } });
    await expect(retryModelAdmission(later, new AbortController().signal, { sleep })).rejects.toMatchObject({ status: 429 });
    expect(later).toHaveBeenCalledTimes(1);
  });
  it.each([{ status: 429, usage: { total: 1 } }, { status: 503, error: { generation_id: 'accepted' } }, { message: 'socket timeout' }, { status: 402 }])('never retries possibly accepted or non-transient requests', async error => {
    const create = jest.fn().mockRejectedValue(error);
    await expect(retryModelAdmission(create, new AbortController().signal)).rejects.toEqual(error);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

it.each(['config.json', 'config.ts', 'config.yaml', 'settings.toml'])('refuses ordinary secret literals for archive %s without known-secret hints', path => {
  const secret = randomBytes(24).toString('hex');
  const content = path.endsWith('json') ? JSON.stringify({ auth: { password: secret } })
    : path.endsWith('ts') ? `export const STRIPE_SECRET_KEY = '${secret}';`
      : `ACCESS_TOKEN = "${secret}"`;
  expect(sourceExportRisk(path, content, text => text)).not.toBeNull();
  expect(sourceExportRisk('main.ts', 'export const count = 42;', text => text)).toBeNull();
});