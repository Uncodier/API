import { randomBytes, randomUUID } from 'node:crypto';
import { createRequirementExecutionBoundary } from '../requirement-execution-boundary';
import { BeforeEffectError, createRedactor, operationFingerprint } from '@/lib/harness/security';
import { SessionStoreError } from '@/lib/harness/store';
import { MemorySessionStore } from '@/lib/harness/memory-store';
import { createMemoryArtifactStore } from '@/lib/harness/artifact-store';
import { RESULT_MAX_BYTES, SNAPSHOT_MAX_BYTES, serializedBytes } from '@/lib/harness/engine-results';
import type { ArtifactStore, HarnessSession, HarnessTool, SessionStore } from '@/lib/harness/types';

function fixture(options: { session?: Partial<HarnessSession>; tools?: HarnessTool[]; secrets?: string[] } = {}) {
  const events: string[] = [];
  const snapshots: HarnessSession[] = [];
  const logs: any[] = [];
  const artifactTexts: string[] = [];
  const id = randomUUID();
  const requirementId = randomUUID();
  const session: HarnessSession = { id, version: 1, status: 'running',
    request: { objective: 'Offline synthetic task', repository: { url: 'https://example.test/repository' }, requirementId,
      limits: { maxTurns: 20, maxOutputTokens: 2000, maxTotalTokens: 2000000, maxActiveMs: 600000 } },
    turns: 0, allocatedTokens: 0, activeMs: 0, messages: [], uncertainOperations: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...options.session };
  const run = { requirementId, sessionId: id, siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(),
    runId: randomUUID(), executionGeneration: 1 };
  const store: SessionStore = { create: jest.fn(), load: jest.fn(), claim: jest.fn(), release: jest.fn(), control: jest.fn(),
    assertOwner: jest.fn(async () => { events.push('owner'); }),
    save: jest.fn(async value => { events.push(value.pending ? 'save:pending' : 'save');
      const copy = structuredClone({ ...value, version: value.version + 1 }); snapshots.push(copy); return copy; }) };
  const artifacts: ArtifactStore = {
    reserve: jest.fn(async () => { events.push('reserve'); }),
    put: jest.fn(async (_session, _site, _owner, call, text) => { events.push('artifact'); artifactTexts.push(text);
      return { id: call, chars: text.length, bytes: Buffer.byteLength(text) }; }),
    read: jest.fn(async () => ({ text: 'Synthetic result page', totalChars: 21, nextOffset: null })),
  };
  const writeLog = jest.fn(async event => {
    expect(['error', 'agent_action', 'tool_call', 'tool_result']).toContain(event.log_type);
    events.push(`log:${event.log_type}`); logs.push(structuredClone(event));
  });
  const assertActive = jest.fn(async () => {});
  const controller = new AbortController();
  const input = { session, run, store, artifacts, writeLog, assertActive, owner: randomUUID(),
    signal: controller.signal, tools: options.tools || [], redact: createRedactor(options.secrets) };
  const adapter = createRequirementExecutionBoundary(input);
  const model = async (calls: Array<{ id: string; name: string; args?: any }> = [], content = '') => {
    await adapter.boundary.beforeModel({ system: 'Canonical instructions', messages: adapter.getMessages(), tools: [], maxOutputTokens: 100 });
    await adapter.boundary.onModelMessage({ role: 'assistant', content,
      tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args || {}) } })) });
  };
  const execute = (name: string, id: string, args: any, callback: () => Promise<any>) => adapter.boundary.executeTool({ name, id, args }, callback);
  const control = (name: string, id: string, args: any) => execute(name, id, args, () => adapter.controlTools.find(tool => tool.name === name).execute(args));
  return { adapter, input, session, run, events, snapshots, logs, artifactTexts, store, artifacts, writeLog, assertActive, controller, model, execute, control };
}

describe('canonical requirement execution durability boundary (offline)', () => {
  test('persists model allocation before inference without a system log; prose does not complete', async () => {
    const f = fixture(); await f.adapter.initialize();
    await f.model([], 'Everything is done.');
    expect(f.snapshots[0]).toMatchObject({ turns: 1, status: 'running' });
    expect(f.snapshots[0].allocatedTokens).toBeGreaterThan(100);
    expect(f.events.indexOf('save')).toBeLessThan(f.events.indexOf('log:agent_action'));
    expect(f.logs.every(log => log.log_type !== 'system')).toBe(true);
    await f.adapter.boundary.afterTurn([{ role: 'assistant', content: 'not authoritative' }]);
    await f.adapter.finish();
    expect(f.adapter.getSession().status).toBe('running');
    expect(f.adapter.getMessages()[0].content).toBe('Everything is done.');
  });

  test('executes exact canonical callback, not the harness implementation; checkpoints precede effects', async () => {
    const harnessExecute = jest.fn(async () => ({ ok: true }));
    const f = fixture({ tools: [{ name: 'write', effect: 'write', description: '', parameters: {}, execute: harnessExecute }] });
    await f.adapter.initialize(); await f.model([{ id: 'call-one', name: 'write', args: { path: 'a.txt' } }]);
    const canonicalExecute = jest.fn(async () => {
      f.events.push('effect');
      expect(f.snapshots.at(-1)?.pending?.call.id).toBe('call-one');
      expect(f.snapshots.at(-1)?.messages[0].toolCalls?.[0].id).toBe('call-one');
      return { success: true, canonicalWrapper: true };
    });
    expect(await f.execute('write', 'call-one', { path: 'a.txt' }, canonicalExecute)).toEqual({ success: true, canonicalWrapper: true });
    expect(canonicalExecute).toHaveBeenCalledTimes(1); expect(harnessExecute).not.toHaveBeenCalled();
    expect(f.events.indexOf('reserve')).toBeLessThan(f.events.indexOf('effect'));
    expect(f.events.indexOf('log:tool_call')).toBeLessThan(f.events.indexOf('effect'));
    expect(f.events.indexOf('save:pending')).toBeLessThan(f.events.indexOf('effect'));
    expect(f.events.indexOf('artifact')).toBeLessThan(f.events.indexOf('log:tool_result'));
    expect(f.events.at(-1)).toBe('save');
    expect(f.adapter.getSession().pending).toBeUndefined();
    expect(f.artifacts.reserve).toHaveBeenCalledWith(f.session.id, f.run.siteId, f.input.owner, 'call-one', RESULT_MAX_BYTES);
  });

  test('host wrapper receives durable operation context and cannot dispatch outside a callback', async () => {
    const host = jest.fn(async (_args: any, context: any) => { await context.assertActive(); return { ok: true }; });
    const f = fixture({ tools: [{ name: 'host', effect: 'write', description: '', parameters: {}, execute: host }] });
    await expect(f.adapter.executeHarnessTool('host', {})).rejects.toMatchObject({ name: 'RecoveryError' });
    await f.adapter.initialize(); await f.model([{ id: 'host-call', name: 'host' }]);
    await f.execute('host', 'host-call', {}, () => f.adapter.executeHarnessTool('host', {}));
    expect(host).toHaveBeenCalledWith({}, expect.objectContaining({ sessionId: f.session.id, operationId: 'host-call', signal: f.controller.signal }));
  });

  test.each(['assistant-log', 'tool-log', 'pending-save', 'artifact-reserve'])('failure at %s blocks dispatch without retry', async failure => {
    const f = fixture(); await f.adapter.initialize(); const callback = jest.fn(async () => ({ ok: true }));
    if (failure === 'assistant-log') {
      f.writeLog.mockRejectedValueOnce(new Error('Synthetic log unavailable'));
      await expect(f.model([{ id: 'call', name: 'unknown_write' }])).rejects.toMatchObject({ name: 'RecoveryError' });
      expect(f.adapter.getSession().turns).toBe(1);
      expect(f.adapter.getSession().messages.at(-1)?.toolCalls?.[0].id).toBe('call');
    } else {
      await f.model([{ id: 'call', name: 'unknown_write' }]);
      if (failure === 'tool-log') f.writeLog.mockRejectedValueOnce(new Error('Synthetic log unavailable'));
      if (failure === 'pending-save') (f.store.save as jest.Mock).mockRejectedValueOnce(new SessionStoreError('storage'));
      if (failure === 'artifact-reserve') (f.artifacts.reserve as jest.Mock).mockRejectedValueOnce(new Error('Synthetic quota failure'));
      await expect(f.execute('unknown_write', 'call', {}, callback)).rejects.toMatchObject({ name: 'RecoveryError' });
    }
    await expect(f.execute('unknown_write', 'call', {}, callback)).rejects.toMatchObject({ name: 'RecoveryError' });
    expect(callback).not.toHaveBeenCalled();
  });

  test.each(['artifact', 'result-log', 'receipt-save'])('failure at %s after effect retains durable pending and is never retried', async failure => {
    const f = fixture(); await f.adapter.initialize(); await f.model([{ id: 'call', name: 'unknown_write' }]);
    if (failure === 'artifact') (f.artifacts.put as jest.Mock).mockRejectedValueOnce(new Error('Synthetic storage failure'));
    if (failure === 'result-log') f.writeLog.mockImplementation(async event => { if (event.log_type === 'tool_result') throw new Error('Synthetic log failure'); });
    if (failure === 'receipt-save') (f.store.save as jest.Mock).mockImplementation(async value => {
      if (!value.pending) throw new SessionStoreError('storage');
      const copy = structuredClone(value); f.snapshots.push(copy); return copy;
    });
    const callback = jest.fn(async () => ({ ok: true }));
    await expect(f.execute('unknown_write', 'call', {}, callback)).rejects.toMatchObject({ name: 'RecoveryError' });
    expect(f.snapshots.at(-1)?.pending?.call.id).toBe('call');
    expect(f.adapter.getSession().pending?.call.id).toBe('call');
    await expect(f.execute('unknown_write', 'call', {}, callback)).rejects.toMatchObject({ name: 'RecoveryError' });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('unknown writes become uncertain; same operation with a new ID cannot replay', async () => {
    const f = fixture(); await f.adapter.initialize(); await f.model([{ id: 'first', name: 'unknown_write' }]);
    const callback = jest.fn(async () => { throw new Error('Synthetic interrupted provider response'); });
    await f.execute('unknown_write', 'first', {}, callback);
    expect(f.adapter.getSession().uncertainOperations).toContain(operationFingerprint('unknown_write', {}));
    await f.adapter.boundary.afterTurn([]);
    await f.model([{ id: 'second', name: 'unknown_write' }]);
    expect(await f.execute('unknown_write', 'second', {}, callback)).toMatchObject({ ok: false, error: { code: 'RECONCILIATION_REQUIRED' } });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test.each(['read', 'before-effect'])('%s failures do not invent uncertain writes', async kind => {
    const f = fixture({ tools: kind === 'read' ? [{ name: 'action', effect: 'read', description: '', parameters: {}, execute: jest.fn() }] : [] });
    await f.adapter.initialize(); await f.model([{ id: 'call', name: 'action' }]);
    await f.execute('action', 'call', {}, async () => { throw kind === 'read' ? new Error('Synthetic failure') : new BeforeEffectError('Synthetic preflight'); });
    expect(f.adapter.getSession().uncertainOperations).toEqual([]);
  });

  test('ownership failure inside a trusted adapter is fatal, not a normal tool error', async () => {
    const f = fixture({ tools: [{ name: 'host', effect: 'write', description: '', parameters: {},
      execute: async (_args, context) => { f.assertActive.mockRejectedValueOnce(new Error('Synthetic lease loss')); await context.assertActive(); return { ok: true }; } }] });
    await f.adapter.initialize(); await f.model([{ id: 'call', name: 'host' }]);
    await expect(f.execute('host', 'call', {}, () => f.adapter.executeHarnessTool('host', {}))).rejects.toMatchObject({ name: 'RecoveryError' });
    expect(f.snapshots.at(-1)?.pending?.call.id).toBe('call'); expect(f.artifacts.put).not.toHaveBeenCalled();
  });

  test('secret-changing args and duplicate IDs reject the entire batch before effects', async () => {
    const secret = randomBytes(32).toString('hex');
    for (const calls of [[{ id: 'a', name: 'write', args: { value: secret } }], [{ id: 'a', name: 'write' }, { id: 'a', name: 'write' }]]) {
      const f = fixture({ secrets: [secret] }); await f.adapter.initialize();
      await expect(f.model(calls)).rejects.toMatchObject({ name: 'RecoveryError' });
      expect(f.adapter.getSession().messages).toEqual([]);
      expect(JSON.stringify(f.snapshots) + JSON.stringify(f.logs)).not.toContain(secret);
      expect(f.artifacts.reserve).not.toHaveBeenCalled();
    }
  });

  test('redacts runtime-generated credentials in prose, wrapper results, artifacts and logs', async () => {
    const username = randomBytes(12).toString('hex'); const password = randomBytes(24).toString('hex');
    const token = randomBytes(32).toString('hex'); const url = new URL('https://provider.example.test/resource');
    url.username = username; url.password = password; url.searchParams.set('access_token', token);
    const f = fixture({ secrets: [username, password, token] }); await f.adapter.initialize();
    await f.model([{ id: 'call', name: 'unknown_write' }], `Synthetic provider URL ${url}`);
    const result = await f.execute('unknown_write', 'call', {}, async () => ({ success: true, provider: url.toString(), authorization: `Bearer ${token}` }));
    const serialized = JSON.stringify([f.snapshots, f.logs, f.artifactTexts, result, f.adapter.getMessages()]);
    for (const sensitive of [username, password, token]) expect(serialized).not.toContain(sensitive);
    expect(serialized).toContain('[REDACTED]');
  });

  test('large results preserve full redacted artifact but keep snapshots and logs bounded', async () => {
    const f = fixture(); await f.adapter.initialize(); await f.model([{ id: 'call', name: 'read' }]);
    const value = 'x'.repeat(100000);
    await f.execute('read', 'call', {}, async () => ({ ok: true, output: { value } }));
    expect(f.artifactTexts[0]).toContain(value);
    expect(f.adapter.getSession().messages.at(-1)?.content.length).toBeLessThan(12000);
    expect(f.logs.at(-1).tool_result).toMatchObject({ truncated: true, artifact: { id: 'call' } });
    expect(serializedBytes(f.adapter.getSession())).toBeLessThan(SNAPSHOT_MAX_BYTES);
  });

  test('legacy pending and outstanding batches pause without replay; reconciliation errors are idempotent across runs', async () => {
    const call = { id: 'legacy', name: 'write', arguments: '{}' };
    const pending = { call, fingerprint: operationFingerprint('write', {}), effect: 'write' as const };
    const history = [{ role: 'user' as const, content: 'Historical objective' }, { role: 'assistant' as const, content: '', toolCalls: [call] }];
    const f = fixture({ session: { pending, messages: history, turns: 9, allocatedTokens: 12345, activeMs: 200 } });
    await f.adapter.initialize();
    expect(f.adapter.getSession()).toMatchObject({ status: 'paused', reason: 'migration_pending_operation_requires_reconciliation',
      pending, turns: 9, allocatedTokens: 12345, messages: history });
    expect(f.artifacts.reserve).not.toHaveBeenCalled();
    const again = createRequirementExecutionBoundary({ ...f.input, session: f.adapter.getSession(), run: { ...f.run, runId: randomUUID() } });
    const oldKeys = f.logs.map(log => log.key); await again.initialize();
    expect(f.logs.slice(oldKeys.length).map(log => log.key)).toEqual([oldKeys.at(-1)]);
    expect(f.logs[0]).toMatchObject({ log_type: 'error', is_error: true });
    expect(f.adapter.getSession()).toMatchObject({ assistantExecutionVersion: 0,
      uncertainOperations: [pending.fingerprint] });
    expect(f.logs.some(log => log.details?.historical_import)).toBe(false);
    await expect(f.model()).rejects.toMatchObject({ name: 'RecoveryError' });
  });

  test('legacy undispatched read is not automatically resumed', async () => {
    const f = fixture({ session: { messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read', arguments: '{}' }] }] } });
    await f.adapter.initialize();
    expect(f.adapter.getSession()).toMatchObject({ status: 'paused', reason: 'migration_pending_operation_requires_reconciliation' });
    expect(f.adapter.getSession().messages).toHaveLength(1);
    expect(f.artifacts.put).not.toHaveBeenCalled();
  });

  test('afterTurn refuses dangling calls and cannot overwrite durable history', async () => {
    const f = fixture(); await f.adapter.initialize(); await f.model([{ id: 'call', name: 'write' }]);
    await expect(f.adapter.boundary.afterTurn([{ role: 'assistant', content: 'fake completion' }])).rejects.toMatchObject({ name: 'RecoveryError' });
    expect(f.adapter.getSession().messages[0].toolCalls?.[0].id).toBe('call');
  });

  test('finish_task rejects other outstanding calls; only a successful explicit finish completes', async () => {
    const f = fixture(); await f.adapter.initialize();
    const args = { summary: 'Implemented with offline checks only', outcome: 'partial' };
    await f.model([{ id: 'finish-early', name: 'finish_task', args }, { id: 'read', name: 'read' }]);
    expect(await f.control('finish_task', 'finish-early', args)).toMatchObject({ ok: false });
    expect(f.adapter.getSession().status).toBe('running');
    await f.execute('read', 'read', {}, async () => ({ ok: true })); await f.adapter.boundary.afterTurn([]);
    await f.model([{ id: 'finish', name: 'finish_task', args }]); await f.control('finish_task', 'finish', args);
    expect(f.adapter.getSession().status).toBe('running');
    await f.adapter.finish();
    expect(f.adapter.getSession()).toMatchObject({ status: 'completed', reason: 'partial' });
  });

  test('only trusted reconciliation proof can unblock an uncertain operation', async () => {
    const reconcile = jest.fn(async () => ({ state: 'retry_safe' as const, proof: 'Synthetic provider documented idempotency' }));
    const f = fixture({ tools: [{ name: 'write', effect: 'write', description: '', parameters: {}, execute: jest.fn(), reconcile }] });
    await f.adapter.initialize(); await f.model([{ id: 'first', name: 'write' }]);
    const callback = jest.fn(async () => { throw new Error('Synthetic interrupted write'); });
    await f.execute('write', 'first', {}, callback); await f.adapter.boundary.afterTurn([]);
    await f.model([{ id: 'reconcile', name: 'reconcile_operation', args: { operationId: 'first' } }]);
    expect(await f.control('reconcile_operation', 'reconcile', { operationId: 'first' })).toEqual({ ok: true, output: { state: 'retry_safe' } });
    expect(reconcile).toHaveBeenCalledWith({}, expect.objectContaining({ operationId: 'first' }));
    await f.adapter.boundary.afterTurn([]); await f.model([{ id: 'second', name: 'write' }]);
    await f.execute('write', 'second', {}, callback);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(f.adapter.getSession().reconciledOperations?.[operationFingerprint('write', {})]).toBeUndefined();
  });

  test.each(['turns', 'tokens', 'time', 'output'])('historical %s limit does not block credit-funded inference', async kind => {
    const f = fixture();
    if (kind === 'turns') f.input.session.turns = f.input.session.request.limits.maxTurns;
    if (kind === 'tokens') f.input.session.allocatedTokens = f.input.session.request.limits.maxTotalTokens;
    if (kind === 'time') f.input.session.activeMs = f.input.session.request.limits.maxActiveMs;
    if (kind === 'output') f.input.session.request.limits.maxOutputTokens = 1;
    const adapter = createRequirementExecutionBoundary(f.input); await adapter.initialize();
    await expect(adapter.boundary.beforeModel({ system: '', messages: [], tools: [], maxOutputTokens: 100 })).resolves.toBeUndefined();
    expect(adapter.getSession().status).toBe('running');
    expect(adapter.getSession().turns).toBe(f.input.session.turns + 1);
    expect(adapter.getSession().allocatedTokens).toBeGreaterThan(f.input.session.allocatedTokens);
    expect(adapter.getSession().activeMs).toBeGreaterThanOrEqual(f.input.session.activeMs);
    expect(f.writeLog).not.toHaveBeenCalled();
    expect(f.snapshots.at(-1)).toMatchObject({ turns: adapter.getSession().turns,
      allocatedTokens: adapter.getSession().allocatedTokens });
  });

  test.each([0, -1, NaN])('invalid output allowance %s still blocks dispatch', async maxOutputTokens => {
    const f = fixture(); await f.adapter.initialize();
    await expect(f.adapter.boundary.beforeModel({ system: '', messages: [], tools: [], maxOutputTokens })).rejects.toMatchObject({ name: 'RecoveryError' });
    expect(f.adapter.getSession().turns).toBe(0);
  });

  test('aborted signal blocks inference before reservations', async () => {
    const f = fixture(); await f.adapter.initialize(); f.controller.abort();
    await expect(f.model()).rejects.toMatchObject({ name: 'RecoveryError' });
    expect(f.store.save).not.toHaveBeenCalled();
  });

  test('thought_process is not part of operation identity or strict control arguments', async () => {
    const host = jest.fn(async () => ({ ok: true }));
    const f = fixture({ tools: [{ name: 'host', effect: 'write', description: '', parameters: {}, execute: host }] });
    await f.adapter.initialize();
    const args = { path: 'synthetic.txt', thought_process: 'Inspect before editing' };
    await f.model([{ id: 'host', name: 'host', args }]);
    await f.execute('host', 'host', args, () => f.adapter.executeHarnessTool('host', { path: 'synthetic.txt' }));
    expect(host).toHaveBeenCalledWith({ path: 'synthetic.txt' }, expect.any(Object));
    const pending = f.snapshots.find(snapshot => snapshot.pending)?.pending;
    expect(pending?.fingerprint).toBe(operationFingerprint('host', { path: 'synthetic.txt' }));
    await f.adapter.boundary.afterTurn([]);
    const finish = { summary: 'Completed offline', outcome: 'implemented', thought_process: 'All receipts returned' };
    await f.model([{ id: 'finish', name: 'finish_task', args: finish }]);
    await f.control('finish_task', 'finish', finish);
    await f.adapter.boundary.afterTurn([]);
    expect(f.adapter.getSession().status).toBe('completed');
  });

  test('history and artifact controls return bounded session-scoped data', async () => {
    const f = fixture(); await f.adapter.initialize();
    const historyArgs = { offset: 0, limit: 1 }; const artifactArgs = { id: 'synthetic-artifact', offset: 2, limit: 10 };
    await f.model([{ id: 'history', name: 'read_session_history', args: historyArgs }, { id: 'artifact', name: 'read_result_artifact', args: artifactArgs }]);
    const history = await f.control('read_session_history', 'history', historyArgs);
    expect(history).toMatchObject({ ok: true, output: { offset: 0, total: 1 } });
    expect(history.output.messages).toHaveLength(1);
    await f.control('read_result_artifact', 'artifact', artifactArgs);
    expect(f.artifacts.read).toHaveBeenCalledWith(f.session.id, f.run.siteId, f.input.owner, 'synthetic-artifact', 2, 10);
  });

  test('model-provided reconciliation claims never authorize another effect', async () => {
    const f = fixture(); await f.adapter.initialize(); await f.model([{ id: 'first', name: 'write' }]);
    await f.execute('write', 'first', {}, async () => ({ success: false, error: 'Synthetic lost receipt' }));
    await f.adapter.boundary.afterTurn([]);
    const args = { operationId: 'first', state: 'not_applied', proof: 'Model says safe' };
    await f.model([{ id: 'reconcile', name: 'reconcile_operation', args }]);
    expect(await f.control('reconcile_operation', 'reconcile', args)).toMatchObject({ ok: false });
    expect(f.adapter.getSession().reconciledOperations).toBeUndefined();
    expect(f.adapter.getSession().uncertainOperations).toContain(operationFingerprint('write', {}));
  });

  test('IDs from earlier completed batches cannot be reused', async () => {
    const f = fixture(); await f.adapter.initialize(); await f.model([{ id: 'first', name: 'read' }]);
    await f.execute('read', 'first', {}, async () => ({ ok: true })); await f.adapter.boundary.afterTurn([]);
    await expect(f.model([{ id: 'first', name: 'read' }])).rejects.toMatchObject({ name: 'RecoveryError' });
    expect(f.adapter.getSession().messages).toHaveLength(2);
  });

  test('real memory store terminal ownership: checkpoint and onStep precede completion, finish is idempotent', async () => {
    const f = fixture(); const store = new MemorySessionStore();
    await store.create({ ...f.session, status: 'queued', version: 0 }, { siteId: f.run.siteId, userId: f.run.userId });
    const claimed = await store.claim(f.session.id, f.run.siteId, f.input.owner, 180);
    const assertActive = jest.fn(async () => {
      const stored = await store.load(f.session.id, f.run.siteId);
      if (stored?.status !== 'running') throw new Error('Synthetic requirement ownership rejects terminal session');
    });
    const checkpoint = jest.fn(async (context: any) => { await context.assertActive(); });
    const adapter = createRequirementExecutionBoundary({ ...f.input, session: claimed!, store, assertActive, onCheckpoint: checkpoint });
    await adapter.initialize();
    const args = { summary: 'Completed offline', outcome: 'partial' };
    await adapter.boundary.beforeModel({ system: '', messages: [], tools: [], maxOutputTokens: 100 });
    await adapter.boundary.onModelMessage({ role: 'assistant', content: '', tool_calls: [{ id: 'finish', type: 'function',
      function: { name: 'finish_task', arguments: JSON.stringify(args) } }] });
    await adapter.boundary.executeTool({ id: 'finish', name: 'finish_task', args },
      () => adapter.controlTools.find(tool => tool.name === 'finish_task').execute(args));
    await assertActive(); // canonical onStep still holds valid ownership
    expect(adapter.getSession().status).toBe('running');
    await adapter.boundary.afterTurn([]);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect((await store.load(f.session.id, f.run.siteId))?.status).toBe('completed');
    const checks = assertActive.mock.calls.length;
    await adapter.finish(); await adapter.boundary.afterTurn([]);
    expect(assertActive).toHaveBeenCalledTimes(checks);
  });

  test('canonical audit cursor preserves history without copying it to logs on either slice', async () => {
    const f = fixture({ session: { messages: [{ role: 'user', content: 'Historical objective' }] } });
    await f.adapter.initialize(); await f.model([], 'Canonical response'); await f.adapter.finish();
    const imported = f.logs.filter(log => log.details?.historical_import);
    expect(imported).toHaveLength(0);
    const next = createRequirementExecutionBoundary({ ...f.input, session: f.adapter.getSession(), run: { ...f.run, runId: randomUUID() } });
    await next.initialize();
    expect(f.logs.filter(log => log.details?.historical_import)).toEqual(imported);
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toMatchObject({ log_type: 'agent_action', message: 'Canonical response' });
    expect(next.getSession()).toMatchObject({ assistantAuditCursor: 2, messages: [
      { role: 'user', content: 'Historical objective' }, { role: 'assistant', content: 'Canonical response' },
    ] });
    expect((next.boundary as any).redact).toBe(f.input.redact);
  });

  async function crashFixture(tools: HarnessTool[] = []) {
    const f = fixture({ tools }); const store = new MemorySessionStore();
    await store.create({ ...f.session, status: 'queued', version: 0 }, { siteId: f.run.siteId, userId: f.run.userId });
    const claimed = (await store.claim(f.session.id, f.run.siteId, f.input.owner, 180))!;
    const input = { ...f.input, session: claimed, store, artifacts: createMemoryArtifactStore(store),
      assertActive: async () => {
        if ((await store.load(f.session.id, f.run.siteId))?.status !== 'running') throw new Error('Synthetic owner inactive');
      } };
    const adapter = createRequirementExecutionBoundary(input); await adapter.initialize();
    const batch = async (calls: Array<{ id: string; name: string; args?: any }>) => {
      await adapter.boundary.beforeModel({ system: '', messages: adapter.getMessages(), tools: [], maxOutputTokens: 100 });
      await adapter.boundary.onModelMessage({ role: 'assistant', content: '', tool_calls: calls.map(call => ({ id: call.id,
        type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args || {}) } })) });
    };
    const resume = async (extra = {}) => {
      const session = (await store.load(f.session.id, f.run.siteId))!;
      const next = createRequirementExecutionBoundary({ ...input, ...extra, session, run: { ...input.run, runId: randomUUID() } });
      await next.initialize(); return next;
    };
    return { ...f, store, input, adapter, batch, resume };
  }

  test('canonical crash before dispatch closes calls as not executed, resumes model, and never duplicates receipts', async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const f = await crashFixture([{ name: 'write', effect: 'write', description: '', parameters: {}, execute }]);
    await f.batch([{ id: 'first', name: 'write' }, { id: 'second', name: 'write' }]);
    const before = f.adapter.getSession(); const next = await f.resume();
    expect(next.getSession()).toMatchObject({ status: 'running', turns: before.turns, allocatedTokens: before.allocatedTokens, uncertainOperations: [] });
    const receipts = next.getSession().messages.filter(message => message.role === 'tool');
    expect(receipts.map(message => message.toolCallId)).toEqual(['first', 'second']);
    receipts.forEach(message => expect(JSON.parse(message.content)).toMatchObject({ ok: false, error: { code: 'OPERATION_NOT_EXECUTED', effectStarted: false } }));
    expect(execute).not.toHaveBeenCalled();
    const again = await f.resume();
    expect(again.getSession().messages).toEqual(next.getSession().messages);
    expect(f.logs.filter(log => log.details?.recovery)).toHaveLength(2);
    await again.boundary.beforeModel({ system: '', messages: again.getMessages(), tools: [], maxOutputTokens: 100 });
    expect(again.getSession().turns).toBe(before.turns + 1);
  });

  test.each(['write', 'read'] as const)('canonical pending %s is never replayed and write reconciliation is reachable', async effect => {
    const execute = jest.fn(async () => ({ ok: true }));
    const reconcile = jest.fn(async () => ({ state: 'not_applied' as const, proof: 'Synthetic trusted provider proof' }));
    const f = await crashFixture([{ name: 'action', effect, description: '', parameters: {}, execute, reconcile }]);
    await f.batch([{ id: 'pending', name: 'action' }, { id: 'undispatched', name: 'action' }]);
    const original = f.adapter.getSession(); const call = original.messages[0].toolCalls![0];
    await f.store.save({ ...original, pending: { call, effect, fingerprint: operationFingerprint('action', {}) } }, f.run.siteId, f.input.owner);
    const next = await f.resume();
    expect(next.getSession().pending).toBeUndefined(); expect(next.getSession().status).toBe('running');
    const receipts = next.getSession().messages.filter(message => message.role === 'tool');
    expect(JSON.parse(receipts[0].content)).toMatchObject({ ok: false, error: { code: 'OPERATION_OUTCOME_UNKNOWN' } });
    expect(JSON.parse(receipts[1].content)).toMatchObject({ ok: false, error: { code: 'OPERATION_NOT_EXECUTED' } });
    expect(next.getSession().uncertainOperations).toEqual(effect === 'write' ? [operationFingerprint('action', {})] : []);
    expect(execute).not.toHaveBeenCalled();
    if (effect === 'write') {
      const args = { operationId: 'pending' };
      await next.boundary.beforeModel({ system: '', messages: next.getMessages(), tools: [], maxOutputTokens: 100 });
      await next.boundary.onModelMessage({ role: 'assistant', content: '', tool_calls: [{ id: 'reconcile', type: 'function',
        function: { name: 'reconcile_operation', arguments: JSON.stringify(args) } }] });
      expect(await next.boundary.executeTool({ id: 'reconcile', name: 'reconcile_operation', args },
        () => next.controlTools.find(tool => tool.name === 'reconcile_operation').execute(args))).toMatchObject({ ok: true });
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(next.getSession().uncertainOperations).toEqual([operationFingerprint('action', {})]);
    }
  });

  test('canonical finish receipt crash completes on initialize before inference with owned checkpoint', async () => {
    const f = await crashFixture(); const args = { summary: 'Honest partial completion', outcome: 'partial' };
    await f.batch([{ id: 'finish', name: 'finish_task', args }]);
    await f.adapter.boundary.executeTool({ id: 'finish', name: 'finish_task', args },
      () => f.adapter.controlTools.find(tool => tool.name === 'finish_task').execute(args));
    expect(f.adapter.getSession().status).toBe('running');
    const checkpoint = jest.fn(async (context: any) => { await context.assertActive(); });
    const next = await f.resume({ onCheckpoint: checkpoint });
    expect(next.getSession()).toMatchObject({ status: 'completed', reason: 'partial', turns: 1 });
    expect(next.getSession().messages.filter(message => message.role === 'tool')).toHaveLength(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    await next.finish(); expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  test('failed recovery receipt save retains fence and pending; repeated initialize uses stable recovery key', async () => {
    const f = await crashFixture(); await f.batch([{ id: 'pending', name: 'write' }]);
    const original = f.adapter.getSession(); const fingerprint = operationFingerprint('write', {});
    await f.store.save({ ...original, pending: { call: original.messages[0].toolCalls![0], effect: 'write', fingerprint } }, f.run.siteId, f.input.owner);
    const save = f.store.save.bind(f.store);
    const spy = jest.spyOn(f.store, 'save').mockImplementation(async (session, site, owner) => {
      if (!session.pending) throw new SessionStoreError('storage');
      return save(session, site, owner);
    });
    await expect(f.resume()).rejects.toMatchObject({ name: 'RecoveryError' });
    expect((await f.store.load(f.session.id, f.run.siteId))?.uncertainOperations).toContain(fingerprint);
    expect((await f.store.load(f.session.id, f.run.siteId))?.pending?.call.id).toBe('pending');
    spy.mockRestore(); const next = await f.resume();
    expect(next.getSession().messages.filter(message => message.role === 'tool')).toHaveLength(1);
    const logs = f.logs.filter(log => log.details?.recovery);
    expect(logs).toHaveLength(2); expect(logs[0].key).toBe(logs[1].key);
  });

  test('legacy migration import cursor never upgrades unfinished legacy calls on manual resume', async () => {
    const f = await crashFixture();
    const legacy = (await f.store.load(f.session.id, f.run.siteId))!;
    legacy.messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'legacy', name: 'write', arguments: '{}' }] });
    await f.store.save(legacy, f.run.siteId, f.input.owner);
    const paused = await f.resume();
    expect(paused.getSession().status).toBe('paused');
    await f.store.release(f.session.id, f.run.siteId, f.input.owner);
    await f.store.control(f.session.id, f.run.siteId, 'resume');
    await f.store.claim(f.session.id, f.run.siteId, f.input.owner, 180);
    const resumed = await f.resume();
    expect(resumed.getSession()).toMatchObject({ status: 'paused', reason: 'migration_pending_operation_requires_reconciliation' });
    expect(resumed.getSession().messages.filter(message => message.role === 'tool')).toHaveLength(0);
  });

  test('crash after artifact put preserves original artifact while recording a distinct unknown outcome', async () => {
    const f = await crashFixture(); await f.batch([{ id: 'pending', name: 'write' }]);
    const original = f.adapter.getSession();
    await f.store.save({ ...original, pending: { call: original.messages[0].toolCalls![0], effect: 'write',
      fingerprint: operationFingerprint('write', {}) } }, f.run.siteId, f.input.owner);
    const secret = randomBytes(32).toString('hex');
    const redact = createRedactor([secret]);
    const previousText = JSON.stringify({ ok: true, output: { receipt: redact(`Synthetic provider receipt ${secret}`) } });
    await f.input.artifacts.reserve(f.session.id, f.run.siteId, f.input.owner, 'pending', RESULT_MAX_BYTES);
    const previousArtifact = await f.input.artifacts.put(f.session.id, f.run.siteId, f.input.owner, 'pending', previousText);
    const put = jest.spyOn(f.input.artifacts, 'put');
    const next = await f.resume();
    expect(next.getSession().pending).toBeUndefined();
    const recovery = next.getSession().messages.find(message => message.toolCallId === 'pending')!;
    expect(JSON.parse(recovery.content)).toMatchObject({ ok: false, error: { code: 'OPERATION_OUTCOME_UNKNOWN', ambiguous: true } });
    const previousPage = await f.input.artifacts.read(f.session.id, f.run.siteId, f.input.owner, previousArtifact.id, 0, 8000);
    expect(previousPage?.text).toBe(previousText);
    // Recovery is persisted in the snapshot/log, without needing more artifact quota.
    expect(JSON.stringify([previousPage, recovery, next.getSession(), f.logs])).not.toContain(secret);
    const again = await f.resume();
    expect(again.getSession().messages.filter(message => message.toolCallId === 'pending')).toHaveLength(1);
    expect(put).not.toHaveBeenCalled();
  });

  test.each([
    { success: true, result: { success: false, error: 'Timeout after dispatch' } },
    { success: true, result: JSON.stringify({ success: false, error: 'Timeout after dispatch' }) },
    { ok: true, output: { success: false, error: 'Timeout after dispatch' } },
  ])('nested failures are durable failures and fence identical writes: %j', async output => {
    const f = fixture(); await f.adapter.initialize();
    const args = { action: 'call', name: 'sendEmail', args: '{"to":"recipient@example.test"}' };
    await f.model([{ id: 'first', name: 'tools', args }]);
    await f.execute('tools', 'first', args, async () => output);
    expect(JSON.parse(f.adapter.getSession().messages.at(-1)!.content)).toMatchObject({ ok: false, error: { ambiguous: true } });
    expect(f.logs.at(-1)).toMatchObject({ log_type: 'tool_result', is_error: true });
    await f.model([{ id: 'second', name: 'tools', args }]);
    const repeat = jest.fn(async () => ({ success: true }));
    await f.execute('tools', 'second', args, repeat);
    expect(repeat).not.toHaveBeenCalled();
  });

  test.each([
    '{ "subject": "Same", "to": "recipient@example.test", "thought_process": "changed" }',
    { subject: 'Same', to: 'recipient@example.test', thought_process: 'changed' },
  ])('equivalent routed arguments cannot bypass a fence: %j', async inner => {
    const f = fixture(); await f.adapter.initialize();
    const first = { action: 'call', name: 'sendEmail', args: JSON.stringify({ to: 'recipient@example.test', subject: 'Same', thought_process: 'first' }) };
    await f.model([{ id: 'first', name: 'tools', args: first }]);
    await f.execute('tools', 'first', first, async () => ({ success: false, error: 'Unknown remote outcome' }));
    const second = { action: 'call', name: 'sendEmail', args: inner };
    await f.model([{ id: 'second', name: 'tools', args: second }]);
    const repeat = jest.fn(async () => ({ success: true }));
    await f.execute('tools', 'second', second, repeat);
    expect(repeat).not.toHaveBeenCalled();
    // An actual changed destination remains a distinct operation.
    const distinct = { ...second, args: { to: 'other@example.test', subject: 'Same' } };
    await f.model([{ id: 'distinct', name: 'tools', args: distinct }]);
    await f.execute('tools', 'distinct', distinct, repeat);
    expect(repeat).toHaveBeenCalledTimes(1);
  });

  test('persisted old router fences are upgraded without dropping historical identities', async () => {
    const args = { action: 'call', name: 'sendEmail', args: '{"to":"recipient@example.test","subject":"Same"}' };
    const oldIdentity = operationFingerprint('tools', args);
    const f = fixture({ session: { uncertainOperations: [oldIdentity], messages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'first', name: 'tools', arguments: JSON.stringify(args) }] },
      { role: 'tool', toolCallId: 'first', content: JSON.stringify({ ok: false, error: { ambiguous: true } }) },
    ] } });
    const resumed = f.adapter;
    await resumed.initialize();
    expect(resumed.getSession().uncertainOperations).toContain(oldIdentity);
    expect(resumed.getSession().uncertainOperations).toContain(operationFingerprint('sendEmail', { subject: 'Same', to: 'recipient@example.test' }));
    expect(f.snapshots.at(-1)?.uncertainOperations).toEqual(resumed.getSession().uncertainOperations);
  });

  test('a routed rejection proven not executed stays retryable, without erasing real uncertainty', async () => {
    const f = fixture(); await f.adapter.initialize();
    const args = { action: 'call', name: 'sendEmail', args: '{"to":"recipient@example.test"}' };
    await f.model([{ id: 'denied', name: 'tools', args }]);
    await f.execute('tools', 'denied', args, async () => ({ success: true, result: { success: false, executed: false, error: 'Validation rejected' } }));
    expect(f.adapter.getSession().uncertainOperations).toEqual([]);
    expect(JSON.parse(f.adapter.getSession().messages.at(-1)!.content)).toMatchObject({ ok: false, error: { effectStarted: false } });
  });

  test('recovery, artifact reading and finish remain possible with a completely full artifact quota', async () => {
    const f = await crashFixture(); await f.batch([{ id: 'pending', name: 'write' }]);
    const snapshot = f.adapter.getSession();
    await f.store.save({ ...snapshot, pending: { call: snapshot.messages[0].toolCalls![0], effect: 'write',
      fingerprint: operationFingerprint('write', {}) } }, f.run.siteId, f.input.owner);
    let artifactId = '';
    for (let n = 0; n < 16; n++) {
      const operation = `filled-${n}`;
      await f.input.artifacts.reserve(f.session.id, f.run.siteId, f.input.owner, operation, RESULT_MAX_BYTES);
      artifactId = (await f.input.artifacts.put(f.session.id, f.run.siteId, f.input.owner, operation, 'x'.repeat(RESULT_MAX_BYTES))).id;
    }
    const reserve = jest.spyOn(f.input.artifacts, 'reserve');
    const put = jest.spyOn(f.input.artifacts, 'put');
    const resumed = await f.resume();
    expect(resumed.getSession().pending).toBeUndefined();
    expect(resumed.getSession().uncertainOperations).toContain(operationFingerprint('write', {}));
    const control = async (id: string, name: string, args: any) => {
      await resumed.boundary.beforeModel({ system: '', messages: resumed.getMessages(), tools: [], maxOutputTokens: 100 });
      await resumed.boundary.onModelMessage({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      const result = await resumed.boundary.executeTool({ id, name, args }, () => resumed.controlTools.find(tool => tool.name === name).execute(args));
      await resumed.boundary.afterTurn([]); return result;
    };
    expect(await control('read', 'read_result_artifact', { id: artifactId, limit: 10 })).toMatchObject({ ok: true, output: { text: 'xxxxxxxxxx' } });
    await control('finish', 'finish_task', { summary: 'Partial: write outcome still uncertain; no replay.', outcome: 'partial' });
    expect(resumed.getSession()).toMatchObject({ status: 'completed', reason: 'partial' });
    expect(reserve).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    expect((await f.store.load(f.session.id, f.run.siteId))?.messages.some(message => message.toolCallId === 'finish')).toBe(true);
  });

  test('ordinary effects still require artifact capacity before dispatch', async () => {
    const f = await crashFixture();
    for (let n = 0; n < 16; n++) {
      await f.input.artifacts.reserve(f.session.id, f.run.siteId, f.input.owner, `filled-${n}`, RESULT_MAX_BYTES);
      await f.input.artifacts.put(f.session.id, f.run.siteId, f.input.owner, `filled-${n}`, 'x'.repeat(RESULT_MAX_BYTES));
    }
    await f.batch([{ id: 'must-not-dispatch', name: 'write' }]);
    const effect = jest.fn(async () => ({ ok: true }));
    await expect(f.adapter.boundary.executeTool({ id: 'must-not-dispatch', name: 'write', args: {} }, effect))
      .rejects.toMatchObject({ name: 'RecoveryError' });
    expect(effect).not.toHaveBeenCalled();
  });
});