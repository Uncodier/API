import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { buildAssistantUserContent } from '@/lib/services/robot-instance/assistant-image-content';
import { buildStepExecutionPrompt } from '../step-execution-prompt';
import { createAssistantStepResult } from '../step-result';
import { attachAssistantStepResult } from '../requirement-host';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { siteId: id(1), instanceId: id(2) };

function fixture() {
  const tables: Record<string, any[]> = {
    remote_instances: [{ id: scope.instanceId, site_id: scope.siteId, status: 'running', is_archived: false }],
    requirements: [], requirement_status: [], instance_plans: [],
  };
  let failedTable = '';
  const queries: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const predicates: Array<(row: any) => boolean> = [];
    queries.push({ table, filters });
    let limit = Infinity;
    const q: any = {};
    const value = (row: any, key: string) => key === 'metadata->>runner_instance_id' ? row.metadata?.runner_instance_id : row[key];
    q.select = q.order = q.or = () => q;
    q.eq = (key: string, expected: unknown) => { filters.push([key, expected]); predicates.push(row => value(row, key) === expected); return q; };
    q.in = (key: string, values: unknown[]) => { predicates.push(row => values.includes(value(row, key))); return q; };
    q.limit = (n: number) => { limit = n; return q; };
    const result = () => failedTable === table ? { data: null, error: { message: 'offline' } }
      : { data: tables[table].filter(row => predicates.every(p => p(row))).slice(0, limit), error: null };
    q.maybeSingle = async () => { const r = result(); return { ...r, data: r.data?.[0] ?? null }; };
    q.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
    return q;
  };
  const ownership = loadRuntimeModule<typeof import('../plan-ownership')>(
    'src/app/api/robots/instance/assistant/plan-ownership.ts', { '@/lib/database/supabase-client': { supabaseAdmin: { from } } },
  );
  const seed = (status = 'backlog') => {
    const requirement = { id: id(3), site_id: scope.siteId, status, metadata: { runner_instance_id: scope.instanceId }, backlog: { items: [{ id: 'item', status: 'pending' }] } };
    tables.requirements.push(requirement);
    return requirement;
  };
  return { tables, from, queries, seed, resolve: ownership.resolveAssistantPlanOwnership,
    ownership, fail: (table: string) => { failedTable = table; } };
}

describe('post-conversation plan ownership', () => {
  it('allows a confirmed standalone instance and scopes every query by site', async () => {
    const f = fixture();
    await expect(f.resolve(scope)).resolves.toEqual({ state: 'standalone' });
    for (const query of f.queries) expect(query.filters).toContainEqual(['site_id', scope.siteId]);
  });

  it('finds assignment before a first status row or bound plan exists', async () => {
    const f = fixture(); const req = f.seed();
    await expect(f.resolve(scope)).resolves.toEqual({ state: 'managed', requirementId: req.id, runnable: true });
  });

  it('does not confuse terminal history with a new assignment', async () => {
    const f = fixture(); const req = f.seed();
    f.tables.requirement_status.push({ site_id: scope.siteId, instance_id: scope.instanceId, stage: 'done', requirement_id: id(9) });
    await expect(f.resolve(scope)).resolves.toMatchObject({ state: 'managed', requirementId: req.id });
  });

  it('supports legacy status linkage without an assignment', async () => {
    const f = fixture(); const req = f.seed(); req.metadata = {} as any;
    f.tables.requirement_status.push({ site_id: scope.siteId, instance_id: scope.instanceId, stage: 'in-progress', requirement_id: req.id });
    await expect(f.resolve(scope)).resolves.toMatchObject({ state: 'managed', requirementId: req.id });
  });

  it('does not bind a new standalone plan to stale nonterminal history of a finished requirement', async () => {
    const f = fixture(); const req = f.seed('done');
    f.tables.requirement_status.push({ site_id: scope.siteId, instance_id: scope.instanceId, stage: 'in-progress', requirement_id: req.id });
    await expect(f.resolve(scope)).resolves.toEqual({ state: 'standalone' });
    await expect(f.resolve({ ...scope, planRequirementId: req.id })).resolves.toMatchObject({ state: 'managed', runnable: false });
  });

  it.each(['blocked', 'done', 'cancelled'])('never reclassifies a %s bound plan as standalone', async status => {
    const f = fixture(); const req = f.seed(status);
    await expect(f.resolve({ ...scope, planRequirementId: req.id })).resolves.toMatchObject({ state: 'managed', runnable: false });
  });

  it.each(['remote_instances', 'requirements', 'requirement_status'])('does not turn a %s read failure into execution permission', async table => {
    const f = fixture(); f.fail(table);
    await expect(f.resolve(scope)).resolves.toMatchObject({ state: 'unavailable' });
  });

  it.each(['paused', 'stopped', 'stopping', 'archived'])('preserves %s instances', async status => {
    const f = fixture(); Object.assign(f.tables.remote_instances[0], status === 'archived' ? { is_archived: true } : { status });
    await expect(f.resolve(scope)).resolves.toMatchObject({ state: 'unavailable', reason: 'instance_inactive' });
  });

  it('rejects cross-site bound requirements and changed ownership', async () => {
    const f = fixture(); const req = f.seed(); req.site_id = id(7);
    await expect(f.resolve({ ...scope, planRequirementId: req.id })).resolves.toMatchObject({ state: 'unavailable' });
    req.site_id = scope.siteId; req.metadata.runner_instance_id = id(8);
    await expect(f.resolve({ ...scope, planRequirementId: req.id })).resolves.toMatchObject({ state: 'unavailable', reason: 'requirement_owner_changed' });
  });

  it('refuses ambiguous or disappeared bindings instead of guessing', async () => {
    const f = fixture(); f.seed(); const second = f.seed(); second.id = id(4);
    await expect(f.resolve(scope)).resolves.toMatchObject({ state: 'unavailable' });
    f.tables.requirements = [];
    await expect(f.resolve({ ...scope, contextHasLinkedRequirement: true })).resolves.toMatchObject({ state: 'unavailable' });
    await expect(f.resolve({ ...scope, planRequirementId: id(3), contextRequirementId: id(4) })).resolves.toMatchObject({ state: 'unavailable' });
  });

  it('real workflow sees a new requirement after its initial snapshot and preserves work for handoff', async () => {
    const f = fixture();
    const effects = jest.fn();
    const writes = jest.fn();
    const complete = jest.fn();
    const fail = jest.fn();
    const lock = jest.fn();
    const context: any = { instance: { status: 'running' }, initialMessage: 'Research local communities',
      imageAssets: [], customTools: [], systemPrompt: 'Research', hasLinkedRequirement: false,
      executionOptions: { instance_id: scope.instanceId, site_id: scope.siteId, user_id: id(5) } };
    const planSteps = loadRuntimeModule<typeof import('../plan-steps')>('src/app/api/robots/instance/assistant/plan-steps.ts', {
      '@/lib/database/supabase-client': { supabaseAdmin: { from: f.from } },
      './plan-ownership': f.ownership,
      '@/app/api/agents/tools/instance_plan/update/core': { updateInstancePlanCore: writes },
      './assistant-turn': { processAssistantTurn: effects },
      './step-execution-prompt': { buildStepExecutionPrompt },
      './step-result': { createAssistantStepResult },
      './requirement-host': { attachAssistantStepResult },
      '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError: () => false },
      '@/lib/services/skills-service': { SkillsService: {} }, './skill-selection': {},
      '@/app/api/cron/shared/step-git-prompts': {}, '@/lib/services/sandbox-service': {},
      '@/lib/utils/redis-client': { getRedisClient: lock },
    });
    const workflow = loadRuntimeModule<typeof import('../workflow')>('src/app/api/robots/instance/assistant/workflow.ts', {
      './plan-steps': planSteps,
      './steps': { prepareAssistantContext: async () => context },
      './assistant-turn': { processAssistantTurn: async (_context: any, messages: any[]) => {
        expect(context.hasLinkedRequirement).toBe(false);
        const req = f.seed();
        f.tables.instance_plans.push({ id: id(6), instance_id: scope.instanceId, site_id: scope.siteId,
          title: 'Research', status: 'pending', metadata: { requirement_id: req.id },
          steps: [{ id: 'step_1', status: 'pending', order: 1, metadata: { backlog_item_id: 'item' } }] });
        return { isDone: true, text: 'Research queued', messages, usage: {} };
      } },
      './persist-and-fail-steps': { completeUserMessageStep: complete, markAssistantFailedStep: fail },
      './assistant-recovery-steps': { prepareRecoveryStep: async () => ({ ok: true }), guardRecoveryStep: async () => true, checkpointRecoveryStep: async () => true },
      './assistant-respawn-steps': {},
      '@/lib/services/robot-instance/assistant-respawn-policy': { isIncompleteTurn: () => false },
      '@/lib/services/robot-instance/assistant-image-content': { buildAssistantUserContent },
      '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError: () => false },
    });
    const response = await workflow.runAssistantWorkflow(scope.instanceId, 'Research', scope.siteId, id(5), [], false,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, { userMessageLogId: id(8) });
    expect(response).toMatchObject({ execution_status: 'awaiting_requirement_runner', managed_work_resumed: false });
    expect(complete).toHaveBeenCalledWith(id(8), 0);
    for (const fn of [effects, writes, fail, lock]) expect(fn).not.toHaveBeenCalled();
    expect(f.tables.remote_instances).toHaveLength(1);
    expect(f.tables.instance_plans[0].steps[0].status).toBe('pending');
    expect(f.tables.requirements[0].backlog.items[0].status).toBe('pending');
    expect(f.tables.requirements[0].metadata.runner_instance_id).toBe(scope.instanceId);
  });
});