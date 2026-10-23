import { randomBytes, randomUUID } from 'node:crypto';
import { createRequirementResearchTools } from '../requirement-research';
import { createSession } from '../session';
import { createMemorySessionStore } from '../memory-store';
import { runSessionSlice } from '../engine';
import { operationFingerprint } from '../security';
import type { RequirementRun } from '../requirement-types';
import type { RequirementClient } from '../requirement-context';
import type { ModelReply, ToolContext, Workspace } from '../types';

const config = jest.fn(), search = jest.fn(), validate = jest.fn(), deduct = jest.fn();
jest.mock('@/lib/services/search/web-search', () => ({ getWebSearchConfig: () => config(), searchWeb: (...args: unknown[]) => search(...args) }));
jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: { PRICING: { WEB_SEARCH: 0.1 },
  validateCredits: (...args: unknown[]) => validate(...args), deductCredits: (...args: unknown[]) => deduct(...args) } }));

function setup() {
  const run: RequirementRun = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(),
    sessionId: randomUUID(), runId: randomUUID(), executionGeneration: 7 };
  const row = { id: run.requirementId, site_id: run.siteId, user_id: run.userId,
    metadata: { runner_instance_id: run.instanceId, requirement_execution_generation: run.executionGeneration } };
  const query = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn(async () => ({ data: row, error: null })) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  const db = { from: jest.fn(() => query), rpc: jest.fn(async () => ({ data: true, error: null })) };
  const context: ToolContext = { sessionId: run.sessionId, operationId: randomUUID(), signal: new AbortController().signal,
    assertActive: jest.fn(async () => {}) };
  const tool = createRequirementResearchTools({ run, client: db as unknown as RequirementClient })[0];
  return { run, row, query, db, context, tool };
}

beforeEach(() => {
  jest.clearAllMocks();
  config.mockReturnValue({ origin: 'https://search.example.test', deployment: 'offline', apiKey: randomBytes(32).toString('hex') });
  validate.mockResolvedValue(true); deduct.mockResolvedValue({ success: true });
  search.mockResolvedValue({ success: true, data: { answer: 'Grounded answer',
    results: [{ title: 'Source', url: 'https://source.example.test/article', content: 'Source snippet' }],
    citations: [{ type: 'url_citation', title: 'Source', url: 'https://source.example.test/article' }],
    sources: [{ type: 'url', url: 'https://source.example.test/article' }] } });
});

it('constructs the expected query-only tool without configuration, billing, DB access or paid search', () => {
  const s = setup();
  expect(s.tool).toMatchObject({ name: 'webSearch', effect: 'write', parameters: { additionalProperties: false,
    properties: { query: { type: 'string', minLength: 1, maxLength: 8000 } } } });
  expect(s.tool.reconcile).toBeUndefined();
  for (const fn of [config, validate, deduct, search, s.db.from, s.db.rpc]) expect(fn).not.toHaveBeenCalled();
});

it('uses existing configured search and billing defaults only after real host/run checks', async () => {
  const s = setup();
  const result = await s.tool.execute({ query: '  public research  ' }, s.context);
  expect(result).toMatchObject({ ok: true, output: { success: true, results: [{ title: 'Source', url: 'https://source.example.test/article', snippet: 'Source snippet' }],
    citations: [{ url: 'https://source.example.test/article' }], sources: [{ url: 'https://source.example.test/article' }] } });
  expect(s.query.eq).toHaveBeenCalledWith('id', s.run.requirementId);
  expect(s.query.eq).toHaveBeenCalledWith('site_id', s.run.siteId);
  expect(s.query.eq).toHaveBeenCalledWith('user_id', s.run.userId);
  expect(s.db.rpc).toHaveBeenCalledWith('assert_agent_requirement_run', {
    p_requirement_id: s.run.requirementId, p_run_id: s.run.runId, p_generation: 7, p_session_id: s.run.sessionId,
    p_allow_terminal: false, p_renew_seconds: 300,
  });
  expect(validate).toHaveBeenCalledWith(s.run.siteId, 0.1);
  expect(deduct).toHaveBeenCalledTimes(1);
  expect(deduct).toHaveBeenCalledWith(s.run.siteId, 0.1, 'web_search', expect.any(String), {
    provider: 'azure_bing', requirement_id: s.run.requirementId, session_id: s.run.sessionId,
    operation_id: s.context.operationId, query_sha256: expect.any(String),
  });
  expect(search).toHaveBeenCalledWith('public research', { search_depth: 'basic', max_results: 5, include_answer: true });
  expect(deduct.mock.invocationCallOrder[0]).toBeLessThan(search.mock.invocationCallOrder[0]);
  expect(s.db.rpc).toHaveBeenCalledTimes(4);
});

it.each([{ query: '' }, { query: ' ' }, { query: 'x'.repeat(8001) }, { query: 'valid', site_id: randomUUID() },
  { query: 'valid', user_id: randomUUID() }, { query: 'valid', requirementId: randomUUID() },
  { query: 'valid', endpoint: 'https://other.example.test' }, { query: 'valid', search_depth: 'comprehensive' }])('rejects malformed/model-selected identity or provider arguments %#', async args => {
  const s = setup();
  expect(await s.tool.execute(args, s.context)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', effectStarted: false } });
  for (const fn of [config, validate, deduct, search, s.db.from]) expect(fn).not.toHaveBeenCalled();
});

it.each(['site', 'user', 'requirement', 'runner', 'generation', 'run', 'session', 'lease', 'abort'])('fails closed on changed %s ownership', async kind => {
  const s = setup();
  if (kind === 'site') s.row.site_id = randomUUID();
  if (kind === 'user') s.row.user_id = randomUUID();
  if (kind === 'requirement') s.row.id = randomUUID();
  if (kind === 'runner') s.row.metadata.runner_instance_id = randomUUID();
  if (kind === 'generation') s.row.metadata.requirement_execution_generation++;
  if (kind === 'run') s.db.rpc.mockResolvedValue({ data: false, error: null });
  if (kind === 'session') s.context.sessionId = randomUUID();
  if (kind === 'lease') (s.context.assertActive as jest.Mock).mockRejectedValue(new Error('Lease lost'));
  if (kind === 'abort') s.context.signal = AbortSignal.abort();
  expect(await s.tool.execute({ query: 'research' }, s.context)).toMatchObject({ ok: false, error: { code: 'OWNER_LOST', effectStarted: false } });
  for (const fn of [config, validate, deduct, search]) expect(fn).not.toHaveBeenCalled();
});

it('copies the trusted run instead of allowing later mutation to retarget billing', async () => {
  const s = setup(), siteId = s.run.siteId;
  s.run.siteId = randomUUID();
  expect((await s.tool.execute({ query: 'research' }, s.context)).ok).toBe(true);
  expect(validate).toHaveBeenCalledWith(siteId, 0.1);
});

it.each(['config', 'credits', 'credits_error', 'ownership_before_charge'])('does not charge or dispatch on %s admission failure', async kind => {
  const s = setup();
  if (kind === 'config') config.mockImplementation(() => { throw new Error(randomBytes(32).toString('hex')); });
  if (kind === 'credits') validate.mockResolvedValue(false);
  if (kind === 'credits_error') validate.mockRejectedValue(new Error('Unavailable'));
  if (kind === 'ownership_before_charge') validate.mockImplementation(async () => { s.row.site_id = randomUUID(); return true; });
  expect(await s.tool.execute({ query: 'research' }, s.context)).toMatchObject({ ok: false, error: { effectStarted: false } });
  expect(deduct).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
});

it.each(['deduction_false', 'deduction_lost_ack', 'ownership_after_charge', 'provider_failure', 'provider_lost_ack', 'abort_after_search'])('marks %s as paid/ambiguous, with no automatic retry', async kind => {
  const s = setup();
  if (kind === 'deduction_false') deduct.mockResolvedValue({ success: false });
  if (kind === 'deduction_lost_ack') deduct.mockRejectedValue(new Error('Lost ACK'));
  if (kind === 'ownership_after_charge') deduct.mockImplementation(async () => { s.row.site_id = randomUUID(); return { success: true }; });
  if (kind === 'provider_failure') search.mockResolvedValue({ success: false, error: 'Failure', error_status: 503 });
  if (kind === 'provider_lost_ack') search.mockRejectedValue(new Error('Lost ACK'));
  if (kind === 'abort_after_search') search.mockImplementation(async () => { s.context.signal = AbortSignal.abort(); return { success: true, data: {} }; });
  expect(await s.tool.execute({ query: 'research' }, s.context)).toMatchObject({ ok: false, error: { code: 'SEARCH_OUTCOME_UNKNOWN', ambiguous: true } });
  expect(deduct).toHaveBeenCalledTimes(1);
  expect(search).toHaveBeenCalledTimes(['deduction_false', 'deduction_lost_ack', 'ownership_after_charge'].includes(kind) ? 0 : 1);
});

it('redacts runtime-generated credentials in results and rejects credential-bearing queries', async () => {
  const s = setup();
  const key = randomBytes(32).toString('hex'), token = randomBytes(32).toString('hex'), password = randomBytes(32).toString('hex');
  config.mockReturnValue({ origin: 'https://search.example.test', deployment: 'offline', apiKey: key });
  const authenticated = new URL('https://source.example.test/article'); authenticated.username = 'offline'; authenticated.password = password;
  search.mockResolvedValue({ success: true, data: { answer: `${key} Bearer ${token} ${authenticated.href}`, results: [], citations: [], sources: [], apiKey: key } });
  const result = await s.tool.execute({ query: 'research' }, s.context);
  expect(result.ok).toBe(true);
  for (const value of [key, token, password]) expect(JSON.stringify(result)).not.toContain(value);
  expect(await s.tool.execute({ query: `Bearer ${token}` }, s.context)).toMatchObject({ ok: false, error: { code: 'SENSITIVE_QUERY' } });
  expect(search).toHaveBeenCalledTimes(1); expect(deduct).toHaveBeenCalledTimes(1);
});

it('never serializes provider or billing error details', async () => {
  const s = setup(), secret = randomBytes(32).toString('hex');
  deduct.mockRejectedValue(new Error(secret));
  const result = await s.tool.execute({ query: 'research' }, s.context);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result).toMatchObject({ error: { ambiguous: true } });
});

it.each(['credentials', 'protocol', 'oversized'])('refuses %s source URLs instead of inventing or truncating citations', async kind => {
  const s = setup(), secret = randomBytes(32).toString('hex');
  const source = new URL('https://source.example.test/article');
  if (kind === 'credentials') { source.username = 'offline'; source.password = secret; }
  if (kind === 'protocol') source.protocol = 'ftp:';
  if (kind === 'oversized') source.pathname = 'x'.repeat(5000);
  search.mockResolvedValue({ success: true, data: { answer: 'Source', results: [{ title: 'Source', url: source.href, content: 'Text' }], citations: [], sources: [] } });
  const result = await s.tool.execute({ query: 'research' }, s.context);
  expect(result).toMatchObject({ ok: false, error: { ambiguous: true } });
  expect(JSON.stringify(result)).not.toContain(secret);
});

it('bounds model-visible research and does not forward arbitrary provider fields', async () => {
  const s = setup();
  search.mockResolvedValue({ success: true, data: { answer: 'a'.repeat(20000), rawProviderResponse: 'not for model',
    results: Array.from({ length: 30 }, () => ({ title: 't'.repeat(1000), url: 'https://source.example.test', content: 's'.repeat(4000) })),
    citations: [], sources: [] } });
  const result = await s.tool.execute({ query: 'research' }, s.context);
  expect(result.ok).toBe(true);
  const output = result.output as { answer: string; results: Array<{ title: string; snippet: string }> };
  expect(output.answer).toHaveLength(12000); expect(output.results).toHaveLength(5);
  expect(output.results[0].title).toHaveLength(500); expect(output.results[0].snippet).toHaveLength(2000);
  expect(JSON.stringify(result)).not.toContain('not for model');
});

const reply = (id: string, name = 'webSearch', args: Record<string, unknown> = { query: 'research' }): ModelReply => ({
  message: { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] }, finishReason: 'tool_calls',
});

it.each(['pending', 'receipt', 'provider'].flatMap(kind =>
  ['research', ' research ', '\t research\n', '\u00a0research\u00a0'].map(query => ({ kind, query }))))(
  'uses real engine replay fencing after $kind failure with query $query', async ({ kind, query }) => {
  const s = setup(), store = createMemorySessionStore();
  const initial = createSession({ objective: 'Research public sources', repository: { url: 'https://repo.example.test/project.git' },
    limits: { maxTurns: 10, maxOutputTokens: 256, maxTotalTokens: 1000000, maxActiveMs: 60000 } }, s.run.sessionId);
  initial.request.requirementId = s.run.requirementId;
  await store.create(initial, { siteId: s.run.siteId, userId: s.run.userId });
  const session = (await store.claim(initial.id, s.run.siteId, 'worker', 180))!;
  const workspace = { ref: { provider: 'vercel', id: 'offline', root: '/offline' } } as Workspace;
  const model = { respond: jest.fn().mockResolvedValueOnce(reply('first', 'webSearch', { query: ' research ' }))
    .mockResolvedValueOnce(reply('retry', 'webSearch', { query }))
    .mockResolvedValueOnce(reply('done', 'finish_task', { summary: 'Reported search uncertainty', outcome: 'implemented' })) };
  const input = { session, store, workspace, owner: 'worker', siteId: s.run.siteId, tools: [s.tool], model };
  if (kind === 'provider') {
    search.mockRejectedValue(new Error('Lost response'));
    const result = await runSessionSlice(input);
    expect(result.messages.find(message => message.toolCallId === 'retry')?.content).toContain('RECONCILIATION_REQUIRED');
  } else {
    const save = store.save.bind(store);
    const spy = jest.spyOn(store, 'save').mockImplementation(async (current, site, owner) => {
      if (kind === 'pending' ? !!current.pending : current.messages.some(message => message.toolCallId === 'first')) throw new Error('Offline persistence failure');
      return save(current, site, owner);
    });
    await expect(runSessionSlice(input)).rejects.toThrow('Offline persistence failure');
    spy.mockRestore();
    if (kind === 'receipt') {
      await store.release(session.id, s.run.siteId, 'worker');
      const recovery = (await store.claim(session.id, s.run.siteId, 'recovery', 180))!;
      expect(recovery.pending?.effect).toBe('write');
      const result = await runSessionSlice({ ...input, session: recovery, owner: 'recovery' });
      expect(result.messages.find(message => message.toolCallId === 'first')?.content).toContain('OPERATION_OUTCOME_UNKNOWN');
      expect(result.messages.find(message => message.toolCallId === 'retry')?.content).toContain('RECONCILIATION_REQUIRED');
    }
  }
  expect(deduct).toHaveBeenCalledTimes(kind === 'pending' ? 0 : 1);
  expect(search).toHaveBeenCalledTimes(kind === 'pending' ? 0 : 1);
});

it.each(['pending', 'uncertain'])('preserves pre-normalization %s paid fences on resume', async kind => {
  const s = setup(), store = createMemorySessionStore();
  const initial = createSession({ objective: 'Research public sources', repository: { url: 'https://repo.example.test/project.git' },
    limits: { maxTurns: 10, maxOutputTokens: 256, maxTotalTokens: 1000000, maxActiveMs: 60000 } }, s.run.sessionId);
  initial.request.requirementId = s.run.requirementId;
  const oldCall = reply('legacy', 'webSearch', { query: ' research ' }).message.toolCalls![0];
  const oldFingerprint = operationFingerprint('webSearch', { query: ' research ' });
  initial.messages.push({ role: 'assistant', content: '', toolCalls: [oldCall] });
  if (kind === 'pending') initial.pending = { call: oldCall, effect: 'write', fingerprint: oldFingerprint };
  else {
    initial.uncertainOperations.push(oldFingerprint);
    initial.messages.push({ role: 'tool', toolCallId: 'legacy', content: JSON.stringify({ ok: false, error: { ambiguous: true, code: 'SEARCH_OUTCOME_UNKNOWN' } }) });
  }
  await store.create(initial, { siteId: s.run.siteId, userId: s.run.userId });
  const session = (await store.claim(initial.id, s.run.siteId, 'worker', 180))!;
  const workspace = { ref: { provider: 'vercel', id: 'offline', root: '/offline' } } as Workspace;
  const model = { respond: jest.fn().mockResolvedValueOnce(reply('retry', 'webSearch', { query: '\tresearch\n' }))
    .mockResolvedValueOnce(reply('done', 'finish_task', { summary: 'Reported uncertainty', outcome: 'partial' })) };
  const result = await runSessionSlice({ session, store, workspace, owner: 'worker', siteId: s.run.siteId, tools: [s.tool], model });
  expect(result.status).toBe('completed');
  expect(result.messages.find(message => message.toolCallId === 'retry')?.content).toContain('RECONCILIATION_REQUIRED');
  expect(result.uncertainOperations).toEqual(expect.arrayContaining([oldFingerprint, operationFingerprint('webSearch', { query: 'research' })]));
  expect(deduct).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
});

it('normalizes before dispatch without merging different searches or admitting invalid arguments', async () => {
  const s = setup(), store = createMemorySessionStore();
  const initial = createSession({ objective: 'Research public sources', repository: { url: 'https://repo.example.test/project.git' },
    limits: { maxTurns: 10, maxOutputTokens: 256, maxTotalTokens: 1000000, maxActiveMs: 60000 } }, s.run.sessionId);
  initial.request.requirementId = s.run.requirementId;
  await store.create(initial, { siteId: s.run.siteId, userId: s.run.userId });
  const session = (await store.claim(initial.id, s.run.siteId, 'worker', 180))!;
  const workspace = { ref: { provider: 'vercel', id: 'offline', root: '/offline' } } as Workspace;
  search.mockRejectedValueOnce(new Error('Lost response'));
  const model = { respond: jest.fn()
    .mockResolvedValueOnce(reply('first', 'webSearch', { query: ' first query ' }))
    .mockResolvedValueOnce(reply('empty', 'webSearch', { query: ' \t ' }))
    .mockResolvedValueOnce(reply('extra', 'webSearch', { query: 'second query', siteId: s.run.siteId }))
    .mockResolvedValueOnce(reply('second', 'webSearch', { query: ' second query ' }))
    .mockResolvedValueOnce(reply('done', 'finish_task', { summary: 'Partial research', outcome: 'partial' })) };
  const result = await runSessionSlice({ session, store, workspace, owner: 'worker', siteId: s.run.siteId, tools: [s.tool], model });
  for (const id of ['empty', 'extra']) expect(result.messages.find(message => message.toolCallId === id)?.content).toContain('INVALID_ARGUMENTS');
  expect(result.status).toBe('completed');
  expect(deduct).toHaveBeenCalledTimes(2);
  expect(search.mock.calls.map(call => call[0])).toEqual(['first query', 'second query']);
});