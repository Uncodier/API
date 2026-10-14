import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { modelContext, runSessionSlice, type RunSliceInput } from '../engine';
import { createMemorySessionStore } from '../memory-store';
import { createSession } from '../session';
import { createRedactor, operationFingerprint } from '../security';
import { createWorkspaceTools } from '../workspace-tools';
import type { HarnessModel, HarnessSession, HarnessTool, Message, ModelReply, SessionLimits, ToolCall, ToolResult, Workspace } from '../types';

jest.mock('@vercel/sandbox', () => ({ Sandbox: { get: jest.fn(), create: jest.fn() } }));

const scope = { siteId: 'offline-site', userId: 'offline-user' };
const owner = 'offline-owner';
const defaultLimits: SessionLimits = { maxTurns: 30, maxOutputTokens: 256, maxTotalTokens: 1000000, maxActiveMs: 60000 };
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const reply = (...toolCalls: ToolCall[]): ModelReply => ({ message: { role: 'assistant', content: '', toolCalls }, finishReason: 'tool_calls' });
const finish = (id = 'finish'): ModelReply => reply(call(id, 'finish_task', { summary: 'Implemented; checks and limitations reported.', outcome: 'implemented' }));
type ModelInput = Parameters<HarnessModel['respond']>[0];
type Step = ModelReply | ((input: ModelInput) => ModelReply | Promise<ModelReply>);
function scripted(...steps: Step[]): HarnessModel & { respond: jest.Mock } {
  return { respond: jest.fn(async (input: ModelInput) => {
    const step = steps.shift();
    if (!step) throw new Error('Unexpected extra model generation');
    return typeof step === 'function' ? step(input) : step;
  }) };
}
function tool(name: string, effect: HarnessTool['effect'], execute: HarnessTool['execute']): HarnessTool {
  return { name, effect, execute, description: `Offline ${name}`, parameters: { type: 'object', additionalProperties: false } };
}
function receipt(session: HarnessSession, id: string): ToolResult {
  const message = session.messages.find(item => item.role === 'tool' && item.toolCallId === id);
  expect(message).toBeDefined();
  return JSON.parse(message!.content);
}
function expectToolPairs(messages: Message[]): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.toolCalls?.length) {
      expect(messages.slice(index + 1, index + 1 + message.toolCalls.length).map(result => result.toolCallId))
        .toEqual(message.toolCalls.map(item => item.id));
    }
    if (message.role === 'tool') {
      expect(messages.slice(0, index).some(previous => previous.toolCalls?.some(item => item.id === message.toolCallId))).toBe(true);
    }
  }
}

describe('portable continuous engine with durable boundaries', () => {
  let root: string;
  let workspace: Workspace;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'portable-engine-'));
    const confined = (path: string) => {
      const absolute = resolve(root, path);
      if (!absolute.startsWith(root + sep)) throw new Error('Path outside offline workspace');
      return absolute;
    };
    workspace = {
      ref: { provider: 'vercel', id: 'offline-filesystem', root },
      readFile: jest.fn(async path => readFile(confined(path), 'utf8')),
      writeFile: jest.fn(async (path, content) => { await writeFile(confined(path), content, 'utf8'); }),
      exec: jest.fn(async input => {
        if (input.command !== 'node --test arithmetic.test.cjs') throw new Error('Only the offline test command is enabled');
        return new Promise(resolveResult => {
          execFile(process.execPath, ['--test', confined('arithmetic.test.cjs')], { cwd: root, env: { NODE_ENV: 'test' }, timeout: 3000 }, (error, stdout, stderr) => {
            resolveResult({ stdout, stderr, exitCode: error ? 1 : 0 });
          });
        });
      }),
      processStatus: jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      stopProcess: jest.fn(async () => {}), suspend: jest.fn(async () => {}),
    };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function setup(model: HarnessModel, tools: HarnessTool[] = [], limits: Partial<SessionLimits> = {}, now?: () => number): Promise<RunSliceInput> {
    const store = createMemorySessionStore({ now });
    const initial = createSession({ objective: 'Repair this arbitrary repository without product gates.',
      repository: { url: 'https://example.test/arithmetic-library.git' }, limits: { ...defaultLimits, ...limits } });
    await store.create(initial, scope);
    const session = (await store.claim(initial.id, scope.siteId, owner, 180))!;
    return { store, session, owner, siteId: scope.siteId, model, tools, workspace, now };
  }

  it('edits an ephemeral repo, observes a real failing test, repairs and continues for more than five turns with all tools', async () => {
    await writeFile(join(root, 'arithmetic.cjs'), 'exports.add = (a, b) => a - b;\n');
    await writeFile(join(root, 'arithmetic.test.cjs'), "const { test } = require('node:test'); const assert = require('node:assert/strict'); const { add } = require('./arithmetic.cjs'); test('adds', () => assert.equal(add(2, 3), 5));\n");
    const read = tool('read_file', 'read', async args => ({ ok: true, output: await workspace.readFile(z.string().parse(args.path)) }));
    const write = tool('write_file', 'write', async (args, context) => {
      await context.assertActive();
      await workspace.writeFile(z.string().parse(args.path), z.string().parse(args.content));
      return { ok: true, output: { path: args.path as string } };
    });
    const exec = createWorkspaceTools(workspace).find(item => item.name === 'exec')!;
    const model = scripted(
      reply(call('read-1', 'read_file', { path: 'arithmetic.cjs' })),
      reply(call('write-1', 'write_file', { path: 'arithmetic.cjs', content: 'exports.add = (a, b) => a * b;\n' })),
      reply(call('test-1', 'exec', { command: 'node --test arithmetic.test.cjs' })),
      input => { expect(JSON.stringify(input.messages)).toContain('COMMAND_EXIT_NONZERO'); return reply(call('read-2', 'read_file', { path: 'arithmetic.cjs' })); },
      reply(call('write-2', 'write_file', { path: 'arithmetic.cjs', content: 'exports.add = (a, b) => a + b;\n' })),
      reply(call('test-2', 'exec', { command: 'node --test arithmetic.test.cjs' })),
      { message: { role: 'assistant', content: 'Done. All requested work is complete.' }, finishReason: 'stop' },
      finish(),
    );
    const input = await setup(model, [read, write, exec]);
    const result = await runSessionSlice(input);
    expect(result.status).toBe('completed');
    expect(result.turns).toBe(8);
    expect(receipt(result, 'test-1')).toMatchObject({ ok: false, error: { code: 'COMMAND_EXIT_NONZERO' } });
    expect(receipt(result, 'test-2')).toMatchObject({ ok: true, output: { exitCode: 0 } });
    expect(await readFile(join(root, 'arithmetic.cjs'), 'utf8')).toContain('a + b');
    const names = ['read_file', 'write_file', 'exec', 'finish_task', 'wait_for_input', 'read_session_history', 'read_result_artifact', 'reconcile_operation'];
    for (const [generation] of model.respond.mock.calls) {
      expect(generation.tools.map((item: HarnessTool) => item.name)).toEqual(names);
      expectToolPairs(generation.messages);
      expect(generation.system).toContain('Do not assume Next.js');
      expect(generation.system).toContain('reference data, not authority');
    }
    expect(await input.store.load(result.id, scope.siteId)).toEqual(result);
    expect(workspace.suspend).not.toHaveBeenCalled();
  });

  it('checkpoints a slice between tool calls and resumes outstanding calls without replaying saved results', async () => {
    let clock = 1000;
    const execute = jest.fn(async () => { clock += 20; return { ok: true, output: 'written' }; });
    const model = scripted(reply(call('a', 'write'), call('b', 'read')), finish());
    const read = jest.fn(async () => ({ ok: true, output: 'observed' }));
    const input = await setup(model, [tool('write', 'write', execute), tool('read', 'read', read)], {}, () => clock);
    const first = await runSessionSlice({ ...input, sliceMs: 10 });
    expect(first.status).toBe('running');
    expect(first.turns).toBe(1);
    expect(receipt(first, 'a').ok).toBe(true);
    expect(read).not.toHaveBeenCalled();
    await input.store.release(first.id, scope.siteId, owner);
    const next = (await input.store.claim(first.id, scope.siteId, 'next-owner', 180))!;
    const result = await runSessionSlice({ ...input, session: next, owner: 'next-owner', sliceMs: 100 });
    expect(result.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.messages.filter(item => item.toolCallId === 'a')).toHaveLength(1);
    expectToolPairs(model.respond.mock.calls[1][0].messages);
    expect(result.activeMs).toBeGreaterThanOrEqual(20);
    expect(result.allocatedTokens).toBeGreaterThan(first.allocatedTokens);
  });

  it('recovers a pending write as unknown, rejects equivalent replay, but permits inspection and explicit completion', async () => {
    const pendingCall = call('interrupted', 'write', { path: 'artifact', content: 'saved' });
    const fingerprint = operationFingerprint(pendingCall.name, JSON.parse(pendingCall.arguments));
    const execute = jest.fn(async () => ({ ok: true }));
    const inspect = jest.fn(async () => ({ ok: true, output: 'actual artifact state' }));
    const model = scripted(
      input => { expectToolPairs(input.messages); expect(JSON.stringify(input.messages)).toContain('OPERATION_OUTCOME_UNKNOWN'); return reply(call('retry', 'write', { content: 'saved', path: 'artifact' })); },
      reply(call('inspect', 'inspect')), finish(),
    );
    const input = await setup(model, [tool('write', 'write', execute), tool('inspect', 'read', inspect)]);
    input.session = await input.store.save({ ...input.session,
      messages: [...input.session.messages, { role: 'assistant', content: '', toolCalls: [pendingCall] }],
      pending: { call: pendingCall, fingerprint, effect: 'write' },
    }, scope.siteId, owner);
    await input.store.control(input.session.id, scope.siteId, 'pause');
    await input.store.control(input.session.id, scope.siteId, 'resume', 'Inspect the existing artifact before changing it.');
    input.session = (await input.store.claim(input.session.id, scope.siteId, owner, 180))!;
    const result = await runSessionSlice(input);
    expect(result.status).toBe('completed');
    expect(receipt(result, 'interrupted')).toMatchObject({ ok: false, error: { code: 'OPERATION_OUTCOME_UNKNOWN', ambiguous: true } });
    expect(receipt(result, 'retry')).toMatchObject({ ok: false, error: { code: 'RECONCILIATION_REQUIRED' } });
    expect(result.uncertainOperations).toContain(fingerprint);
    expect(result.pending).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('does not execute a write unless its pending checkpoint was saved', async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const input = await setup(scripted(reply(call('write', 'write'))), [tool('write', 'write', execute)]);
    const save = input.store.save.bind(input.store);
    jest.spyOn(input.store, 'save').mockImplementation(async (session, site, worker) => {
      if (session.pending) throw new Error('Offline checkpoint failure');
      return save(session, site, worker);
    });
    await expect(runSessionSlice(input)).rejects.toThrow('Offline checkpoint failure');
    expect(execute).not.toHaveBeenCalled();
  });

  it('never automatically replays a completed side effect when saving its receipt fails', async () => {
    const execute = jest.fn(async () => { await workspace.writeFile('receipt.txt', 'one effect'); return { ok: true }; });
    const input = await setup(scripted(reply(call('write', 'write'))), [tool('write', 'write', execute)]);
    const save = input.store.save.bind(input.store);
    const saveSpy = jest.spyOn(input.store, 'save').mockImplementation(async (session, site, worker) => {
      if (session.messages.some(item => item.toolCallId === 'write')) throw new Error('Offline receipt failure');
      return save(session, site, worker);
    });
    await expect(runSessionSlice(input)).rejects.toThrow('Offline receipt failure');
    expect(await readFile(join(root, 'receipt.txt'), 'utf8')).toBe('one effect');
    const durable = (await input.store.load(input.session.id, scope.siteId))!;
    expect(durable.pending?.call.id).toBe('write');
    expect(durable.messages.some(item => item.toolCallId === 'write')).toBe(false);
    saveSpy.mockRestore();
    await input.store.release(durable.id, scope.siteId, owner);
    const claimed = (await input.store.claim(durable.id, scope.siteId, 'recovery', 180))!;
    const result = await runSessionSlice({ ...input, session: claimed, owner: 'recovery', model: scripted(finish()) });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipt(result, 'write').error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(result.status).toBe('completed');
  });

  it.each(['pause', 'cancel'] as const)('%s fences a late model response and prevents its write dispatch', async action => {
    let enter!: () => void;
    let complete!: (response: ModelReply) => void;
    const entered = new Promise<void>(resolveEntered => { enter = resolveEntered; });
    const response = new Promise<ModelReply>(resolveResponse => { complete = resolveResponse; });
    const model = scripted(async () => { enter(); return response; });
    const execute = jest.fn(async () => ({ ok: true }));
    const input = await setup(model, [tool('write', 'write', execute)]);
    const running = runSessionSlice(input);
    const rejection = expect(running).rejects.toMatchObject({ code: 'conflict' });
    await entered;
    await input.store.control(input.session.id, scope.siteId, action);
    complete(reply(call('late-write', 'write')));
    await rejection;
    const result = (await input.store.load(input.session.id, scope.siteId))!;
    expect(result.status).toBe(action === 'pause' ? 'paused' : 'cancelled');
    expect(result.messages).toHaveLength(1);
    expect(result.turns).toBe(1);
    expect(result.allocatedTokens).toBeGreaterThan(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an expired worker after another owner claims the session', async () => {
    let clock = 1000;
    const model = scripted(finish());
    const input = await setup(model, [], {}, () => clock);
    clock += 181000;
    const claimed = await input.store.claim(input.session.id, scope.siteId, 'replacement', 180);
    expect(claimed).not.toBeNull();
    await expect(runSessionSlice(input)).rejects.toMatchObject({ code: 'conflict' });
    expect(model.respond).not.toHaveBeenCalled();
  });

  it('fences receipt persistence after a mid-write pause and recovers the uncertain write without dispatching its sibling', async () => {
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolveEntered => { enter = resolveEntered; });
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const execute = jest.fn(async () => { enter(); await gate; await workspace.writeFile('late.txt', 'effect completed'); return { ok: true }; });
    const sibling = jest.fn(async () => ({ ok: true }));
    const input = await setup(scripted(reply(call('late', 'write'), call('sibling', 'read'))), [tool('write', 'write', execute), tool('read', 'read', sibling)]);
    const pending = runSessionSlice(input);
    const rejection = expect(pending).rejects.toMatchObject({ code: 'conflict' });
    await entered;
    await input.store.control(input.session.id, scope.siteId, 'pause');
    release(); await rejection;
    const paused = (await input.store.load(input.session.id, scope.siteId))!;
    expect(paused.status).toBe('paused'); expect(paused.pending?.call.id).toBe('late');
    expect(paused.messages.some(message => message.toolCallId === 'late')).toBe(false);
    expect(sibling).not.toHaveBeenCalled();
    await input.store.control(paused.id, scope.siteId, 'resume', 'Inspect current state.');
    const resumed = (await input.store.claim(paused.id, scope.siteId, 'new-worker', 180))!;
    const result = await runSessionSlice({ ...input, session: resumed, owner: 'new-worker', model: scripted(finish()) });
    expect(result.status).toBe('completed'); expect(execute).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(1);
    expect(receipt(result, 'late').error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(await readFile(join(root, 'late.txt'), 'utf8')).toBe('effect completed');
  });

  it('respects caller cancellation before dispatching a model or tool', async () => {
    const input = await setup(scripted(finish()));
    const controller = new AbortController(); controller.abort();
    await expect(runSessionSlice({ ...input, signal: controller.signal })).rejects.toThrow('Execution cancelled');
    expect(input.model.respond).not.toHaveBeenCalled();
  });

  it('keeps thrown tool errors operational data without removing tools or blocking independent progress', async () => {
    const secret = randomBytes(24).toString('hex');
    const write = jest.fn(async () => { throw new Error(`Remote outcome unclear: Bearer ${secret}`); });
    const read = jest.fn(async () => ({ ok: true, output: 'inspected' }));
    const model = scripted(reply(call('error', 'write')), reply(call('inspect', 'read')), finish());
    const input = await setup(model, [tool('write', 'write', write), tool('read', 'read', read)]);
    const result = await runSessionSlice(input);
    expect(result.status).toBe('completed');
    expect(receipt(result, 'error')).toMatchObject({ ok: false, error: { code: 'TOOL_ERROR', ambiguous: true } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(read).toHaveBeenCalledTimes(1);
    expect(model.respond.mock.calls.map(([generation]) => generation.tools.map((item: HarnessTool) => item.name)))
      .toEqual(Array.from({ length: 3 }, () => ['write', 'read', 'finish_task', 'wait_for_input', 'read_session_history', 'read_result_artifact', 'reconcile_operation']));
  });

  it('requires valid explicit finish rather than prose, rejects invalid controls, and does not claim checks passed', async () => {
    const model = scripted(
      { message: { role: 'assistant', content: 'Finished successfully.' }, finishReason: 'stop' },
      reply(call('invalid-finish', 'finish_task', { summary: 'claimed' })),
      reply(call('partial', 'finish_task', { summary: 'Files repaired; external validation unavailable.', outcome: 'partial' })),
    );
    const result = await runSessionSlice(await setup(model));
    expect(result.turns).toBe(3);
    expect(result.status).toBe('completed');
    expect(result.reason).toBe('partial');
    expect(receipt(result, 'invalid-finish').ok).toBe(false);
    expect(receipt(result, 'partial')).toMatchObject({ ok: true, output: { outcome: 'partial', summary: 'Files repaired; external validation unavailable.' } });
  });

  it('does not finalize in the middle of an outstanding multi-call exchange', async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const earlyFinish = call('too-early', 'finish_task', { summary: 'Before inspection', outcome: 'implemented' });
    const model = scripted(reply(earlyFinish, call('inspection', 'read')), finish());
    const result = await runSessionSlice(await setup(model, [tool('read', 'read', execute)]));
    expect(receipt(result, 'too-early').ok).toBe(false);
    expect(receipt(result, 'inspection').ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.turns).toBe(2); expect(result.status).toBe('completed');
  });

  it('retains reasoning and wait results across an explicit resume without resetting budgets or tools', async () => {
    const reasoningDetails = [{ type: 'reasoning.encrypted', data: randomBytes(24).toString('base64') }];
    const waiting = reply(call('wait', 'wait_for_input', { reason: 'Which offline format should be used?' }));
    waiting.message.reasoningDetails = reasoningDetails;
    const input = await setup(scripted(waiting));
    const first = await runSessionSlice(input);
    expect(first.status).toBe('waiting');
    await input.store.release(first.id, scope.siteId, owner);
    await input.store.control(first.id, scope.siteId, 'resume', 'Use plain text.');
    const resumed = (await input.store.claim(first.id, scope.siteId, owner, 180))!;
    expect(resumed.turns).toBe(first.turns);
    expect(resumed.allocatedTokens).toBe(first.allocatedTokens);
    const model = scripted(generation => {
      expect(generation.messages.find(message => message.toolCalls?.[0].id === 'wait')?.reasoningDetails).toEqual(reasoningDetails);
      expect(generation.messages.at(-1)?.content).toBe('Use plain text.');
      expectToolPairs(generation.messages);
      return finish();
    });
    const result = await runSessionSlice({ ...input, session: resumed, model });
    expect(result.status).toBe('completed');
    expect(result.turns).toBe(2);
    expect(result.messages.filter(message => message.toolCallId === 'wait')).toHaveLength(1);
  });

  it('rejects unavailable tools, malformed JSON and real tool-schema violations without executing workspace commands', async () => {
    const model = scripted(
      reply(call('unavailable', 'not_enabled')),
      reply({ id: 'array', name: 'exec', arguments: '[]' }, { id: 'broken', name: 'exec', arguments: '{' }),
      reply(call('invalid-exec', 'exec', { command: 42 }), call('extra-key', 'exec', { command: 'node --test arithmetic.test.cjs', secrets: true })),
      finish(),
    );
    const result = await runSessionSlice(await setup(model, createWorkspaceTools(workspace)));
    expect(result.status).toBe('completed');
    expect(receipt(result, 'unavailable').error?.code).toBe('TOOL_UNAVAILABLE');
    for (const id of ['array', 'broken', 'invalid-exec', 'extra-key']) expect(receipt(result, id).error?.code).toBe('INVALID_ARGUMENTS');
    expect(workspace.exec).not.toHaveBeenCalled();
  });

  it('rejects duplicate identities before any new effects and asks for fresh calls', async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const model = scripted(reply(call('same', 'write'), call('same', 'write')), reply(call('fresh', 'write')), reply(call('fresh', 'write')), finish());
    const result = await runSessionSlice(await setup(model, [tool('write', 'write', execute)]));
    expect(result.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.messages.filter(message => message.content.includes('invalid or duplicate tool identities'))).toHaveLength(2);
    expect(result.messages.some(message => message.toolCallId === 'same')).toBe(false);
  });

  it('does not execute partial output-limit tool calls and continues using smaller actions', async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const partial = reply(call('partial', 'write')); partial.finishReason = 'length';
    const model = scripted(partial, finish());
    const result = await runSessionSlice(await setup(model, [tool('write', 'write', execute)]));
    expect(result.status).toBe('completed');
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(model.respond.mock.calls[1][0].messages)).toContain('Output limit reached');
    expect(result.messages.some(message => message.toolCalls?.some(item => item.id === 'partial'))).toBe(false);
  });

  it('truncates a large result as valid bounded JSON and keeps targeted-read tools available', async () => {
    const model = scripted(reply(call('large', 'read')), finish());
    const read = tool('read', 'read', async () => ({ ok: true, output: '\\"'.repeat(20000) }));
    const result = await runSessionSlice(await setup(model, [read]));
    const raw = result.messages.find(message => message.toolCallId === 'large')!.content;
    expect(JSON.parse(raw)).toMatchObject({ ok: true, truncated: true });
    expect(raw.length).toBeLessThan(34000);
    expect(model.respond.mock.calls[1][0].tools.map((item: HarnessTool) => item.name)).toContain('read');
  });

  it('redacts known escaped credentials in tool results before persisting or giving them to the model', async () => {
    const token = `${randomBytes(18).toString('hex')}\n"${randomBytes(18).toString('hex')}`;
    const model = scripted(reply(call('output', 'read')), finish());
    const input = await setup(model, [tool('read', 'read', async () => ({ ok: true, output: token }))]);
    const result = await runSessionSlice({ ...input, redact: createRedactor([token]) });
    const output = receipt(result, 'output').output;
    expect(output).not.toBe(token);
    expect(output).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(token).slice(1, -1));
    expect(JSON.stringify(model.respond.mock.calls)).not.toContain(JSON.stringify(token).slice(1, -1));
  });

  it('does not reject ordinary source edits containing emails or password field names', async () => {
    const source = "const contact = 'maintainer@example.test'; const form = { password: input.password };";
    const execute = jest.fn(async () => ({ ok: true }));
    const model = scripted(reply(call('source-edit', 'write', { content: source })), finish());
    const result = await runSessionSlice(await setup(model, [tool('write', 'write', execute)]));
    expect(result.status).toBe('completed');
    expect(execute).toHaveBeenCalledWith({ content: source }, expect.any(Object));
    expect(result.messages.some(message => message.content.includes('Sensitive material'))).toBe(false);
  });

  it('rejects known escaped credentials nested in executable JSON arguments instead of storing or executing them', async () => {
    const token = `${randomBytes(18).toString('hex')}\n"${randomBytes(18).toString('hex')}`;
    const execute = jest.fn(async () => ({ ok: true }));
    const model = scripted(reply(call('unsafe', 'write', { content: token })), finish());
    const input = await setup(model, [tool('write', 'write', execute)]);
    const result = await runSessionSlice({ ...input, redact: createRedactor([token]) });
    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.messages.some(message => message.toolCalls?.some(item => item.id === 'unsafe'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(JSON.stringify(token).slice(1, -1)).slice(1, -1));
    expect(result.messages.some(message => message.content.includes('Sensitive material'))).toBe(true);
  });

  it('recovers interrupted reads by executing them once and preserving the assistant/result pair', async () => {
    const pendingCall = call('read-after-restart', 'read');
    const execute = jest.fn(async () => ({ ok: true, output: 'current state' }));
    const model = scripted(finish());
    const input = await setup(model, [tool('read', 'read', execute)]);
    input.session = await input.store.save({ ...input.session,
      messages: [...input.session.messages, { role: 'assistant', content: '', toolCalls: [pendingCall] }],
      pending: { call: pendingCall, fingerprint: operationFingerprint('read', {}), effect: 'read' },
    }, scope.siteId, owner);
    const result = await runSessionSlice(input);
    expect(result.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipt(result, pendingCall.id)).toEqual({ ok: true, output: 'current state' });
    expectToolPairs(model.respond.mock.calls[0][0].messages);
    expect(result.uncertainOperations).toEqual([]);
  });

  it('serves omitted original history through the real history tool while leaving the durable transcript intact', async () => {
    const original = { role: 'assistant' as const, content: 'Original important discovery', toolCalls: [call('original', 'read')] };
    const model = scripted(
      generation => {
        expect(generation.messages.some(message => message.content === original.content)).toBe(false);
        expect(generation.messages[1].content).toContain('read_session_history');
        return reply(call('history', 'read_session_history', { offset: 1, limit: 2 }));
      }, finish(),
    );
    const input = await setup(model);
    const messages = [...input.session.messages, original, { role: 'tool' as const, toolCallId: 'original', content: '{"ok":true}' }];
    for (let index = 0; index < 35; index++) messages.push({ role: 'user', content: `context-${index} ${'r'.repeat(3000)}` });
    input.session = await input.store.save({ ...input.session, messages }, scope.siteId, owner);
    const result = await runSessionSlice(input);
    const history = JSON.parse(receipt(result, 'history').output as string);
    expect(history.messages).toEqual([original, messages[2]]);
    expect(result.messages.slice(0, messages.length)).toEqual(messages);
    expect(result.status).toBe('completed');
  });

  it('enforces a pre-dispatch turn budget while retaining results from the final allowed model turn', async () => {
    const model = scripted(reply(call('last-tool', 'read')), finish());
    const result = await runSessionSlice(await setup(model, [tool('read', 'read', async () => ({ ok: true }))], { maxTurns: 1 }));
    expect(result.status).toBe('paused'); expect(result.reason).toBe('turn_budget_exhausted');
    expect(model.respond).toHaveBeenCalledTimes(1);
    expect(receipt(result, 'last-tool').ok).toBe(true);
  });

  it('enforces token budget before even the first paid dispatch', async () => {
    const model = scripted(finish());
    const result = await runSessionSlice(await setup(model, [], { maxTotalTokens: 1024 }));
    expect(result.status).toBe('paused'); expect(result.reason).toBe('token_budget_exhausted');
    expect(result.turns).toBe(0); expect(result.allocatedTokens).toBe(0);
    expect(model.respond).not.toHaveBeenCalled();
  });

  it('debits actual provider usage above reservation and prevents another generation after overspend', async () => {
    const response: ModelReply = { message: { role: 'assistant', content: 'Continue implementation.' }, finishReason: 'stop', usage: { inputTokens: 50000, outputTokens: 50000 } };
    const model = scripted(response, finish());
    const result = await runSessionSlice(await setup(model, [], { maxTotalTokens: 100000 }));
    expect(result.status).toBe('paused'); expect(result.reason).toBe('token_budget_exhausted');
    expect(result.allocatedTokens).toBeGreaterThanOrEqual(100000);
    expect(model.respond).toHaveBeenCalledTimes(1);
  });

  it('retains token and turn reservation when the model transport fails without automatic retries', async () => {
    const model = scripted(() => { throw new Error('Offline model unavailable'); });
    const result = await runSessionSlice(await setup(model));
    expect(result.status).toBe('waiting'); expect(result.reason).toContain('model_unavailable');
    expect(result.turns).toBe(1); expect(result.allocatedTokens).toBeGreaterThan(0);
    expect(model.respond).toHaveBeenCalledTimes(1);
  });

  it('checks active elapsed time before further effects, even during a long tool exchange', async () => {
    let clock = 1000;
    const read = jest.fn(async () => { clock += 1100; return { ok: true }; });
    const second = jest.fn(async () => ({ ok: true }));
    const model = scripted(reply(call('first', 'read'), call('blocked', 'second')), finish());
    const result = await runSessionSlice(await setup(model, [tool('read', 'read', read), tool('second', 'write', second)], { maxActiveMs: 1000 }, () => clock));
    expect(result.status).toBe('paused'); expect(result.reason).toBe('active_time_budget_exhausted');
    expect(result.activeMs).toBeGreaterThanOrEqual(1100);
    expect(second).not.toHaveBeenCalled();
  });

  it('rejects capability names that collide with explicit completion controls', async () => {
    const input = await setup(scripted(finish()), [tool('finish_task', 'write', jest.fn())]);
    await expect(runSessionSlice(input)).rejects.toThrow('Duplicate harness tool name');
  });
});

describe('model context protocol and history retention', () => {
  it('canonicalizes pending results ahead of resume messages without mutating stored arrival order', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Objective' },
      { role: 'assistant', content: '', toolCalls: [call('one', 'read'), call('two', 'read')] },
      { role: 'tool', toolCallId: 'one', content: '{}' },
      { role: 'user', content: 'Resume with more context' },
      { role: 'tool', toolCallId: 'two', content: '{}' },
    ];
    const before = structuredClone(messages);
    const context = modelContext(messages);
    expectToolPairs(context);
    expect(context.at(-1)?.content).toBe('Resume with more context');
    expect(messages).toEqual(before);
  });

  it('compacts a long arbitrary-repo history only at complete tool groups and retains the original objective', () => {
    const messages: Message[] = [{ role: 'user', content: 'Repair an Elixir library, not a web application.' }];
    for (let index = 0; index < 30; index++) {
      messages.push({ role: 'assistant', content: 'inspection '.repeat(300), toolCalls: [call(`a-${index}`, 'read'), call(`b-${index}`, 'read')] },
        { role: 'tool', toolCallId: `a-${index}`, content: 'a'.repeat(3000) },
        { role: 'tool', toolCallId: `b-${index}`, content: 'b'.repeat(3000) });
    }
    const before = structuredClone(messages);
    const context = modelContext(messages);
    expect(context[0]).toEqual(messages[0]);
    expect(context[1].content).toContain('read_session_history');
    expect(context.length).toBeLessThan(messages.length);
    expectToolPairs(context);
    expect(messages).toEqual(before);
    expect(JSON.stringify(context).length).toBeLessThan(80000);
  });
});