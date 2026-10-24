import { randomUUID } from 'node:crypto';
import { createMemorySessionStore } from '../memory-store';
import { createMemoryArtifactStore } from '../artifact-store';
import type { RequirementRun } from '../requirement-types';
import type { HarnessModel, ModelReply, Workspace } from '../types';

let store = createMemorySessionStore();
const loadInitial = jest.fn(); const loadSnapshot = jest.fn(); const assertRun = jest.fn();
const finishCycle = jest.fn(); const tools = jest.fn(); const model: HarnessModel = { respond: jest.fn() };
const db = { from: jest.fn() };
const workspace: Workspace = { ref: { provider: 'vercel', id: 'offline', root: '/offline' },
  exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }), readFile: async () => '', writeFile: async () => undefined,
  processStatus: async () => ({ exitCode: 0, stdout: '', stderr: '' }), stopProcess: async () => undefined, suspend: async () => undefined };
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: db }));
jest.mock('../store', () => ({ ...jest.requireActual('../store'), createSessionStore: () => store }));
jest.mock('../artifact-store', () => ({ ...jest.requireActual('../artifact-store'), createArtifactStore: () => createMemoryArtifactStore(store) }));
jest.mock('../host-state-store', () => ({ createHostStateStore: () => ({}) }));
jest.mock('../host-configuration', () => ({ loadSessionConfiguration: async () => ({
  configuration: { redactionValues: [], layers: {} }, values: () => ({}), setLayer: async () => undefined,
}) }));
jest.mock('../requirement-scheduler', () => ({ assertRequirementRun: (...args: unknown[]) => assertRun(...args),
  finishRequirementCycle: (...args: unknown[]) => finishCycle(...args) }));
jest.mock('../requirement-context', () => ({ ...jest.requireActual('../requirement-context'),
  loadRequirementContext: (...args: unknown[]) => loadInitial(...args),
  loadRequirementSnapshot: (...args: unknown[]) => loadSnapshot(...args) }));
jest.mock('../requirement-profile', () => ({ buildRequirementProfile: async (run: RequirementRun) => ({
  repository: { url: 'https://repo.example.test/project.git' }, branch: 'work',
  profile: { siteId: run.siteId, userId: run.userId, environment: {}, allowed: [] },
}) }));
jest.mock('../requirement-tools', () => ({ createRequirementTools: () => tools() }));
jest.mock('../requirement-provisioning', () => ({ createRequirementProvisioningTools: () => [] }));
jest.mock('./retired/requirement-model', () => ({ createRequirementModel: () => model, createBilledHarnessModel: () => model }));
jest.mock('./retired/review-tools', () => ({ createReviewTools: () => [] }));
jest.mock('./retired/model', () => ({ createHarnessModel: () => model }));
jest.mock('../workspace', () => ({ shellQuote: (v: string) => `'${v}'`, openWorkspace: async () => workspace,
  adoptRequirementWorkspace: async () => workspace, replaceWorkspaceEnvironment: async () => undefined }));
jest.mock('../workspace-tools', () => ({ createWorkspaceTools: () => [] }));
jest.mock('../delivery-tools', () => ({ createDeliveryTools: () => [] }));
jest.mock('../archive-tool', () => ({ createArchiveTool: () => [] }));
jest.mock('../capabilities', () => ({ createCapabilityTools: async () => [], refreshTenantEnvironment: jest.fn() }));
jest.mock('../profile', () => ({ resolveHostProfile: () => undefined }));
import { runRequirementCycle } from './retired/requirement-runtime';
import { executeSessionSlice, type SessionRuntimeOptions } from './retired/runtime';
import { createSession } from '../session';
import type { RunSliceInput } from './retired/engine';

const run: RequirementRun = { requirementId: randomUUID(), siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(),
  sessionId: randomUUID(), runId: 'offline', executionGeneration: 0 };
const reply = (id: string, name: string, args = {}): ModelReply => ({ message: { role: 'assistant', content: '',
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }] }, finishReason: 'tool_calls' });
beforeEach(() => {
  jest.clearAllMocks(); store = createMemorySessionStore(); tools.mockResolvedValue([]);
  assertRun.mockResolvedValue(undefined); finishCycle.mockResolvedValue(undefined);
  db.from.mockImplementation(() => {
    const q: any = { select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q,
      single: async () => ({ data: { metadata: {}, type: 'develop' }, error: null }),
      maybeSingle: async () => ({ data: null, error: null }), insert: async () => ({ error: null }) };
    return q;
  });
  loadInitial.mockResolvedValue({ requirement: { id: run.requirementId, site_id: run.siteId, user_id: run.userId,
    title: 'Keep task instructions', instructions: 'Preserve acceptance constraints', status: 'pending', backlog_revision: 1 },
    plans: [], history: [], revision: 'initial-reference' });
});

it('requirement runtime passes its scoped refresh callback through the real session runtime to every model turn', async () => {
  let status = 'pending'; let revision = 1; let turn = 0;
  loadSnapshot.mockImplementation(async () => ({ observed_at: new Date().toISOString(), revision: `r${revision}`,
    requirement: { id: run.requirementId, status, backlog_revision: revision }, backlog: {}, plans: {} }));
  tools.mockResolvedValue([{ name: 'change', effect: 'write', description: 'offline mutation', parameters: {},
    execute: async () => { status = 'completed'; revision++; return { ok: true, output: { status } }; } }]);
  (model.respond as jest.Mock).mockImplementation(async ({ messages }) => {
    const reference = messages.find((m: any) => m.content.includes('Slice-start reference'));
    expect(reference.content).toContain('Preserve acceptance constraints');
    const fresh = messages.find((m: any) => m.content.includes('Advisory context read'));
    if (turn++) {
      expect(fresh.content).toContain('"status":"completed"');
      expect(fresh.content).toContain('backlog revision: 2');
      expect(messages.at(-2).role).toBe('tool');
      expect(messages.at(-2).toolCallId).toBe('change');
      expect(messages.at(-1).role).toBe('user');
      expect(messages.at(-1).content).toContain('CURRENT HOST TOOL AVAILABILITY');
      expect(messages.at(-1).content).toContain('"change"');
      return reply('finish', 'finish_task', { summary: 'Reported actual work.', outcome: 'partial' });
    }
    expect(fresh.content).toContain('"status":"pending"');
    return reply('change', 'change');
  });
  expect((await runRequirementCycle(run)).status).toBe('completed');
  expect(loadInitial).toHaveBeenCalledTimes(1); expect(loadSnapshot).toHaveBeenCalledTimes(2);
  expect(loadSnapshot.mock.calls).toEqual([[run], [run]]);
  const saved = JSON.stringify(await store.load(run.sessionId, run.siteId));
  expect(saved).not.toContain('initial-reference'); expect(saved).not.toContain('Advisory context read');
  expect(saved).not.toContain('CURRENT HOST TOOL AVAILABILITY');
});

it('passes infrastructure checkpoint through the real runtime before terminal persistence', async () => {
  const initial = createSession({ objective: 'Save source on cycle completion', repository: { url: 'https://repo.example.test/project.git' },
    limits: { maxTurns: 10, maxOutputTokens: 256, maxTotalTokens: 1000000, maxActiveMs: 60000 } });
  await store.create(initial, { siteId: run.siteId, userId: run.userId });
  (model.respond as jest.Mock).mockResolvedValue(reply('finish', 'finish_task', { summary: 'Partial work saved.', outcome: 'partial' }));
  const checkpoint = jest.fn(async input => {
    expect(input.workspace).toBe(workspace);
    expect(typeof input.owner).toBe('string');
    expect(input.redact('safe content')).toBe('safe content');
    await input.assertActive();
    expect((await store.load(initial.id, run.siteId))?.status).toBe('running');
  });
  expect((await executeSessionSlice(initial.id, { siteId: run.siteId, userId: run.userId }, { model, checkpoint })).status).toBe('completed');
  expect(checkpoint).toHaveBeenCalledTimes(1);
  expect((await store.load(initial.id, run.siteId))?.reason).toBe('partial');
});

it('the shared callback signature remains optional and read rejection reaches the model as unavailable, not a runtime gate', async () => {
  const getContext: NonNullable<RunSliceInput['getContext']> = async () => { throw new Error('Offline read outage'); };
  const options: SessionRuntimeOptions = { getContext, model };
  const initial = createSession({ objective: 'Continue despite advisory read outage', repository: { url: 'https://repo.example.test/project.git' },
    limits: { maxTurns: 10, maxOutputTokens: 256, maxTotalTokens: 1000000, maxActiveMs: 60000 } });
  await store.create(initial, { siteId: run.siteId, userId: run.userId });
  (model.respond as jest.Mock).mockImplementation(async ({ messages }) => {
    expect(JSON.stringify(messages)).toContain('Context refresh unavailable');
    expect(JSON.stringify(messages)).not.toContain('Offline read outage');
    return reply('finish', 'finish_task', { summary: 'Partial report without inventing state.', outcome: 'partial' });
  });
  expect(await executeSessionSlice(initial.id, { siteId: run.siteId, userId: run.userId }, options))
    .toEqual({ status: 'completed', continue: false });
});