import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemorySessionStore } from '../memory-store';
import { runSessionSlice } from '../engine';
import type { RequirementRun } from '../requirement-types';
import type { Workspace } from '../types';

let store = createMemorySessionStore();
const assertRun = jest.fn(); const finishCycle = jest.fn(); const loadContext = jest.fn(); const buildProfile = jest.fn(); const makeTools = jest.fn(); const executeSlice = jest.fn();
const db = { from: jest.fn(), rpc: jest.fn() };
const claim = jest.fn();
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
jest.mock('workflow/api', () => ({ start: async (fn: (...args: any[]) => Promise<unknown>, args: any[]) => { await fn(...args); return { runId: 'offline-workflow' }; } }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: db }));
jest.mock('../store', () => ({ ...jest.requireActual('../store'), createSessionStore: () => store }));
jest.mock('../requirement-scheduler', () => ({ assertRequirementRun: (...args: unknown[]) => assertRun(...args), finishRequirementCycle: (...args: unknown[]) => finishCycle(...args), claimRequirementRun: (...args: unknown[]) => claim(...args), dueScheduledRequirements: async () => [] }));
jest.mock('../requirement-context', () => ({ ...jest.requireActual('../requirement-context'), loadRequirementContext: (...args: unknown[]) => loadContext(...args), formatRequirementContext: () => 'Existing backlog: add tests. Existing plan: implement addition. Failure history: previous test failed.' }));
jest.mock('../requirement-profile', () => ({ buildRequirementProfile: (...args: unknown[]) => buildProfile(...args) }));
jest.mock('../requirement-tools', () => ({ createRequirementTools: (...args: unknown[]) => makeTools(...args) }));
jest.mock('../requirement-model', () => ({ createRequirementModel: () => ({}) }));
jest.mock('../review-tools', () => ({ createReviewTools: () => [] }));
jest.mock('../requirement-provisioning', () => ({ createRequirementProvisioningTools: () => [] }));
jest.mock('../runtime', () => ({ executeSessionSlice: (...args: unknown[]) => executeSlice(...args) }));
jest.mock('../workspace', () => ({ shellQuote: (value: string) => `'${value}'`, openWorkspace: jest.fn(), adoptRequirementWorkspace: jest.fn() }));
import { runRequirementCycle } from '../requirement-runtime';
import { GET } from '@/app/api/cron/requirements-apps/route';

const run: RequirementRun = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(), sessionId: randomUUID(), runId: 'cron-cycle', executionGeneration: 0 };
beforeEach(() => {
  jest.clearAllMocks(); store = createMemorySessionStore(); assertRun.mockResolvedValue(undefined); finishCycle.mockResolvedValue(undefined);
  makeTools.mockResolvedValue([]);
  loadContext.mockResolvedValue({ requirement: { id: run.requirementId, title: 'Fix addition', instructions: 'Keep public API', status: 'in-progress', site_id: run.siteId, user_id: run.userId }, plans: [], history: [], revision: 'r' });
  buildProfile.mockResolvedValue({ repository: { url: 'https://repo.example.invalid/project.git', ref: 'main' }, branch: 'feature/work', profile: { siteId: run.siteId, userId: run.userId, repositoryUrl: 'https://repo.example.invalid/project.git', environment: {}, allowed: [] } });
  db.from.mockImplementation(() => {
    const query: any = { select: () => query, eq: () => query, not: () => query, order: () => query, limit: () => query,
      single: async () => ({ data: { metadata: {}, type: 'develop' }, error: null }), maybeSingle: async () => ({ data: null, error: null }), insert: async () => ({ error: null }) };
    return query;
  });
});

it('existing cron resumes the same real agent session across cycles and a failed validation does not remove tools', async () => {
  let time = 0; let modelTurn = 0;
  const directory = mkdtempSync(join(tmpdir(), 'requirement-cycle-'));
  const path = join(directory, 'addition.txt'); writeFileSync(path, 'wrong');
  const contents = () => readFileSync(path, 'utf8');
  let tests = 0;
  const tools = [
    { name: 'test', description: 'run tests', parameters: {}, effect: 'read' as const, execute: async () => { tests++; time += 2; return { ok: contents() === 'correct', output: contents() === 'correct' ? 'passed' : 'failed: expected addition' }; } },
    { name: 'edit', description: 'edit file', parameters: {}, effect: 'write' as const, execute: async () => { writeFileSync(path, 'correct'); time += 2; return { ok: true }; } },
  ];
  const workspace = { ref: { provider: 'vercel', id: 'w', root: '/vercel/sandbox' } } as Workspace;
  const toolCall = (name: string, args = {}) => ({ message: { role: 'assistant' as const, content: '', toolCalls: [{ id: `call-${modelTurn}`, name, arguments: JSON.stringify(args) }] }, finishReason: 'tool_calls' as const });
  const model = { respond: jest.fn(async input => {
    expect(input.messages.some((m: any) => m.content.includes('Existing backlog'))).toBe(true);
    expect(input.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(['test', 'edit']));
    modelTurn++;
    return modelTurn === 1 ? toolCall('test') : modelTurn === 2 ? toolCall('edit') : modelTurn === 3 ? toolCall('test')
      : toolCall('finish_task', { summary: 'Fixed addition; test now passes.', outcome: 'implemented' });
  }) };
  executeSlice.mockImplementation(async (id: string, scope: any, options: any) => {
    const session = await store.claim(id, scope.siteId, 'worker', 180);
    const result = await runSessionSlice({ session: session!, siteId: scope.siteId, owner: 'worker', store, workspace, tools, model, context: options.context, assertExecution: options.assertExecution, now: () => time, sliceMs: 1 });
    await store.release(id, scope.siteId, 'worker');
    return { status: result.status, continue: result.status === 'running' };
  });
  const secret = randomUUID(); process.env.CRON_SECRET = secret;
  const tick = async (cycleRun: RequirementRun) => {
    claim.mockResolvedValueOnce({ state: 'claimed', run: cycleRun }).mockResolvedValueOnce(null);
    const response = await GET(new Request('https://api.example.invalid/api/cron/requirements-apps', { headers: { authorization: `Bearer ${secret}` } }));
    expect(response.status).toBe(200);
    expect((await response.json()).results[0].started).toBe(true);
  };
  await tick(run);
  expect(contents()).toBe('wrong'); expect(finishCycle.mock.calls[0][1]).toBe('running');
  await tick({ ...run, runId: 'cron-next' });
  await tick({ ...run, runId: 'cron-next-2' });
  await tick({ ...run, runId: 'cron-next-3' });
  delete process.env.CRON_SECRET;
  expect(contents()).toBe('correct'); expect(tests).toBe(2);
  expect((await store.load(run.sessionId, run.siteId))!.status).toBe('completed');
  expect(new Set(executeSlice.mock.calls.map(args => args[0])).size).toBe(1);
  expect(finishCycle.mock.calls.at(-1)).toEqual([expect.objectContaining({ sessionId: run.sessionId }), 'completed', 'implemented', 'Fixed addition; test now passes.', expect.any(String)]);
  rmSync(directory, { recursive: true, force: true });
});

it('does not call tools or fallback execution after losing requirement ownership', async () => {
  assertRun.mockRejectedValue(new Error('user paused'));
  await runRequirementCycle(run);
  expect(executeSlice).not.toHaveBeenCalled(); expect(loadContext).not.toHaveBeenCalled();
});

it('always exposes webSearch in the requirement runtime even with no optional legacy capabilities', async () => {
  executeSlice.mockImplementation(async (_id: string, _scope: unknown, options: any) => {
    const tools = await options.tools({}, {});
    expect(tools.filter((tool: any) => tool.name === 'webSearch')).toHaveLength(1);
    expect(tools.find((tool: any) => tool.name === 'webSearch').effect).toBe('write');
    return { status: 'waiting' };
  });
  await runRequirementCycle(run);
  expect(executeSlice).toHaveBeenCalledTimes(1);
});