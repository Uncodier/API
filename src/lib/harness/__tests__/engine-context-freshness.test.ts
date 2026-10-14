import { randomBytes } from 'node:crypto';
import { runSessionSlice, type RunSliceInput } from '../engine';
import { createMemorySessionStore } from '../memory-store';
import { createSession } from '../session';
import type { HarnessModel, HarnessTool, Message, ModelReply, Workspace } from '../types';

const scope = { siteId: 'offline-site', userId: 'offline-user' };
const reply = (id: string, name: string, args = {}): ModelReply => ({ finishReason: 'tool_calls',
  message: { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] } });
const finish = (): ModelReply => reply('finish', 'finish_task', { summary: 'Partial work; failing checks remain.', outcome: 'partial' });
const tool = (execute: HarnessTool['execute']): HarnessTool => ({ name: 'change', description: 'Offline mutation', effect: 'write', parameters: {}, execute });
async function setup(model: HarnessModel, tools: HarnessTool[] = [], now?: () => number): Promise<RunSliceInput> {
  const store = createMemorySessionStore({ now });
  const initial = createSession({ objective: 'Preserve original task instructions.', repository: { url: 'https://repo.example.test/project.git' },
    limits: { maxTurns: 30, maxOutputTokens: 256, maxTotalTokens: 1000000, maxActiveMs: 60000 } });
  await store.create(initial, scope);
  return { session: (await store.claim(initial.id, scope.siteId, 'owner', 180))!, store, owner: 'owner', siteId: scope.siteId,
    model, tools, now, workspace: { ref: { provider: 'vercel', id: 'offline', root: '/offline' } } as Workspace };
}
function pairs(messages: Message[]) {
  messages.forEach((message, index) => {
    if (message.toolCalls?.length) expect(messages.slice(index + 1, index + 1 + message.toolCalls.length).map(m => m.toolCallId))
      .toEqual(message.toolCalls.map(call => call.id));
  });
}

it('refreshes mutated state next turn, keeps slice reference before receipts, and never accumulates snapshot copies', async () => {
  let state = 'pending'; let turn = 0;
  const requests: Message[][] = [];
  const getContext = jest.fn(async () => `observed-status=${state}`);
  const model: HarnessModel = { respond: async input => {
    requests.push(input.messages); pairs(input.messages);
    expect(input.messages.filter(m => m.content.includes('Slice-start reference captured at'))).toHaveLength(1);
    expect(input.messages.filter(m => m.content.includes('Advisory context read at'))).toHaveLength(1);
    expect(input.messages[0].content).toContain('Preserve original task instructions');
    if (turn++) {
      expect(input.messages.find(m => m.content.includes('Advisory context'))?.content).toContain('observed-status=completed');
      const reference = input.messages.findIndex(m => m.content.includes('initial-status=pending'));
      const receipt = input.messages.findIndex(m => m.toolCallId === 'change-0');
      expect(reference).toBeLessThan(receipt);
      expect(input.messages.at(-1)?.role).toBe('tool');
    }
    return turn < 4 ? reply(`change-${turn - 1}`, 'change') : finish();
  } };
  const input = await setup(model, [tool(async () => { state = 'completed'; return { ok: true, output: { status: state } }; })]);
  const result = await runSessionSlice({ ...input, context: 'initial-status=pending; keep acceptance constraints.', getContext });
  expect(result.status).toBe('completed'); expect(getContext).toHaveBeenCalledTimes(4);
  const saved = JSON.stringify(await input.store.load(result.id, scope.siteId));
  expect(saved).not.toContain('initial-status'); expect(saved).not.toContain('observed-status');
  expect(requests.map(messages => messages.filter(m => m.role === 'tool').length)).toEqual([0, 1, 2, 3]);
});

it('does not position a stale refresh after a newer successful receipt', async () => {
  let turn = 0;
  const model: HarnessModel = { respond: async ({ messages }) => {
    if (turn++) {
      expect(messages.findIndex(m => m.content.includes('stale-read=pending'))).toBeLessThan(messages.findIndex(m => m.toolCallId === 'write'));
      expect(messages.at(-1)?.content).toContain('completed');
      expect(messages.find(m => m.content.includes('stale-read'))?.content).toContain('Fresh tool receipts take precedence');
      return finish();
    }
    return reply('write', 'change');
  } };
  const input = await setup(model, [tool(async () => ({ ok: true, output: { status: 'completed' } }))]);
  expect((await runSessionSlice({ ...input, getContext: async () => 'stale-read=pending' })).status).toBe('completed');
});

it('read failure is unavailable, not unchanged, preserves all tools and allows partial finish after a failed tool', async () => {
  const sensitive = randomBytes(24).toString('hex'); let turn = 0;
  const getContext = jest.fn().mockResolvedValueOnce('observed-status=old').mockRejectedValue(new Error(sensitive));
  const model: HarnessModel = { respond: async ({ messages, tools }) => {
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['change', 'finish_task', 'wait_for_input']));
    if (turn++) {
      const advisory = messages.find(m => m.content.includes('Advisory context read at'))!;
      expect(advisory.content).toContain('Context refresh unavailable');
      expect(advisory.content).not.toContain('observed-status=old');
      expect(advisory.content).toContain('No fresh state was read');
      expect(JSON.stringify(messages)).not.toContain(sensitive);
      expect(messages.at(-1)?.content).toContain('CHECK_FAILED');
      return finish();
    }
    return reply('failed', 'change');
  } };
  const input = await setup(model, [tool(async () => ({ ok: false, error: { code: 'CHECK_FAILED', message: 'Offline validation failed' } }))]);
  const result = await runSessionSlice({ ...input, getContext });
  expect(result.status).toBe('completed'); expect(result.reason).toBe('partial');
  expect(JSON.stringify(result)).not.toContain(sensitive);
});

it('rereads cross-cycle updates and inserts new slice context before a resumed pending tool pair', async () => {
  let clock = 0; let state = 'first-cycle'; let turn = 0;
  const model: HarnessModel = { respond: async ({ messages }) => {
    if (turn++) {
      pairs(messages);
      expect(messages.find(m => m.content.includes('Advisory context read'))?.content).toContain('between-cycles');
      expect(messages.findIndex(m => m.content.includes('second-reference'))).toBeLessThan(messages.findIndex(m => m.toolCalls?.[0]?.id === 'pending'));
      expect(JSON.stringify(messages)).not.toContain('first-reference');
      return finish();
    }
    clock += 20; return reply('pending', 'change');
  } };
  const input = await setup(model, [tool(async () => ({ ok: true }))], () => clock);
  const first = await runSessionSlice({ ...input, sliceMs: 10, context: 'first-reference', getContext: async () => state });
  expect(first.status).toBe('running'); expect(first.messages.some(m => m.role === 'tool')).toBe(false);
  state = 'between-cycles';
  await input.store.release(first.id, scope.siteId, input.owner);
  const session = (await input.store.claim(first.id, scope.siteId, input.owner, 180))!;
  const result = await runSessionSlice({ ...input, session, context: 'second-reference', getContext: async () => state });
  expect(result.status).toBe('completed');
});

it('ownership loss during a refresh is still enforced separately', async () => {
  const model = { respond: jest.fn() };
  const input = await setup(model);
  await expect(runSessionSlice({ ...input, getContext: async () => {
    await input.store.control(input.session.id, scope.siteId, 'pause');
    throw new Error('Read also failed');
  } })).rejects.toThrow();
  expect(model.respond).not.toHaveBeenCalled();
  expect((await input.store.load(input.session.id, scope.siteId))?.status).toBe('paused');
});

it('bounds a hanging advisory read without making the timeout a tool or completion gate', async () => {
  const input = await setup({ respond: async ({ messages }) => {
    expect(messages.find(m => m.content.includes('Advisory context read'))?.content).toContain('Context refresh unavailable');
    return finish();
  } });
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    if (ms !== 3000) return nativeTimeout(ms);
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    return controller.signal;
  });
  try {
    const getContext = jest.fn(() => new Promise<string>(() => {}));
    expect((await runSessionSlice({ ...input, getContext })).status).toBe('completed');
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(3000);
  } finally { timeout.mockRestore(); }
});

it('retains the slice instructions through transcript shortening and keeps the retained receipt pairs intact', async () => {
  let turn = 0;
  const input = await setup({ respond: async ({ messages }) => {
    pairs(messages);
    expect(messages.filter(m => m.content.includes('Keep this slice instruction'))).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain('Context window shortened');
    if (turn++) {
      expect(messages.at(-1)?.toolCallId).toBe('new-call');
      return finish();
    }
    return reply('new-call', 'change');
  } }, [tool(async () => ({ ok: true }))]);
  input.session = await input.store.save({ ...input.session, messages: [input.session.messages[0],
    ...Array.from({ length: 12 }, (_, i): Message[] => [
      { role: 'assistant', content: '', toolCalls: [{ id: `old-${i}`, name: 'change', arguments: '{}' }] },
      { role: 'tool', toolCallId: `old-${i}`, content: 'old receipt '.repeat(1200) },
    ]).flat()] }, scope.siteId, input.owner);
  expect((await runSessionSlice({ ...input, context: 'Keep this slice instruction' })).status).toBe('completed');
});