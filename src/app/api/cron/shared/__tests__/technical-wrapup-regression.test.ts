import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadCycleInterventionState } from '@/lib/services/cycle-wrapup-state';
import { buildCycleWrapUpSystemPrompt, feedbackRequiredBacklogItems, technicalReviewBacklogItems } from '@/lib/services/cycle-wrapup-prompt';
import { reconcileBacklogBlockedBy, requiresUserAction } from '@/lib/services/requirement-backlog-blockers';
import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import { buildRuntimeTargetPlan, evaluateRuntimeProbe } from '../step-probe-policy';
import { productAttemptLimits, getFlow, classifyRequirementType } from '@/lib/services/requirement-flows';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
const limits = { core: 4, ornamental: 2 };
function item(id: string, overrides: Partial<BacklogItem> = {}): BacklogItem {
  return { id, title: id, kind: 'api', phase_id: 'build', status: 'pending', acceptance: ['POST succeeds'],
    attempts: 0, scope_level: 'full', ...overrides };
}
const decision = { blocker_id: 'credential', category: 'missing_precondition' as const,
  resolution_actor: 'user' as const, reason: 'Provide the provider credential through the secure configuration form.' };

it('keeps UUID validation and HTTP failures strict without turning exhaustion into customer permission', () => {
  const path = '/api/webhooks/makinari';
  const payload = { asset_id: '123' };
  const plan = (expected_statuses: number[]) => buildRuntimeTargetPlan({ validationTargets: [{ kind: 'api', path,
    method: 'POST', expected_statuses, payload }] });
  const probe = (http_status: number) => ({ ok: true, port: 3000, duration_ms: 1, server_errors: [],
    server_log_tail: '', server_log_path: '/tmp/offline', pages: [],
    apis: [{ path, method: 'POST' as const, http_status, payload_source: 'scenario' as const }] });
  expect(plan([200]).apis[0].payload).toEqual(payload); // Preserve evidence, never silently rewrite test inputs.
  expect(evaluateRuntimeProbe(probe(500), plan([200])).hardFailure).toBe(true);
  expect(evaluateRuntimeProbe(probe(500), plan([400, 422])).hardFailure).toBe(true);
  expect(evaluateRuntimeProbe(probe(422), plan([400, 422])).hardFailure).toBe(false);
  const failed = item('webhook', { status: 'needs_review', attempts: 4, review_quarantine: {
    active: true, kind: 'verification_exhausted', reason: 'HTTP 500', quarantined_at: '2026-10-01T00:00:00Z', external_action_revision: 0,
  } });
  const child = item('dependent', { depends_on: [failed.id] });
  reconcileBacklogBlockedBy([failed, child]);
  expect(requiresUserAction(child)).toBe(false);
  expect(feedbackRequiredBacklogItems([failed, child], limits)).toEqual([]);
  expect(technicalReviewBacklogItems([failed, child], limits)).toEqual([failed]);
  const prompt = buildCycleWrapUpSystemPrompt({ title: 'Webhook', requirementId: 'req', instructions: '',
    historyMode: 'empty', historyPromptText: '', digestFiles: [], planCompleted: false,
    requiresUserFeedback: true, wrapUpReason: 'Attempts exhausted; ask whether to bypass UUID validation.' });
  expect(prompt).toContain('INTERNAL TECHNICAL/PLATFORM REVIEW REQUIRED');
  expect(prompt).not.toContain('USER FEEDBACK REQUIRED');
  expect(prompt).not.toContain('explicitly ask the user to reply');
});

it('does not pause independent work or lose genuine customer prerequisites', () => {
  const failed = item('failed', { status: 'needs_review', attempts: 4 });
  const independent = item('independent');
  expect(technicalReviewBacklogItems([failed, independent], limits)).toEqual([]);
  const customer = item('customer', { blocked_by: [decision] });
  expect(feedbackRequiredBacklogItems([failed, customer], limits)).toEqual([customer]);
  expect(technicalReviewBacklogItems([failed, customer], limits)).toEqual([failed]);
  const combined = { ...failed, blocked_by: [decision] };
  expect(feedbackRequiredBacklogItems([combined], limits)).toEqual([combined]);
  expect(technicalReviewBacklogItems([combined], limits)).toEqual([combined]);
  const exhaustedWithCredential = item('both', { attempts: 4, blocked_by: [decision] });
  expect(feedbackRequiredBacklogItems([exhaustedWithCredential], limits)).toEqual([exhaustedWithCredential]);
  expect(technicalReviewBacklogItems([exhaustedWithCredential], limits)).toEqual([exhaustedWithCredential]);
});

it('loads only canonical user decisions, scoped and redacted; rejects legacy dependency/user misclassification', async () => {
  const items = [item('credential', { blocked_by: [decision] }), item('done', { status: 'done', blocked_by: [decision] }),
    item('legacy', { blocked_by: [{ ...decision, category: 'dependency', blocker_id: 'dependency:failed' }] }),
    item('technical', { blocked_by: [{ ...decision, category: 'product_defect', reason: 'Approve fixture repair' }] }),
    item('secret', { blocked_by: [{ ...decision, blocker_id: 'token', reason: 'Missing token. Bearer private-token' }] })];
  const query = { eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue({ data: { backlog: { items } }, error: null }) };
  (supabaseAdmin.from as jest.Mock).mockReturnValue({ select: jest.fn(() => query) });
  const result = await loadCycleInterventionState('req', 'site');
  expect(query.eq).toHaveBeenCalledWith('id', 'req');
  expect(query.eq).toHaveBeenCalledWith('site_id', 'site');
  expect(result?.userDecisionBlockers.map(blocker => blocker.blocker_id)).toEqual(['credential', 'token']);
  expect(JSON.stringify(result)).not.toContain('private-token');
  query.maybeSingle.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
  expect(await loadCycleInterventionState('req', 'site')).toBeNull();
  query.maybeSingle.mockRejectedValue(new Error('network'));
  expect(await loadCycleInterventionState('req', 'site')).toBeNull();
});

it.each(['app', 'document'])('loads fresh runnable backlog using the existing %s attempt limits and dependencies', async type => {
  const attemptLimits = productAttemptLimits(getFlow(classifyRequirementType(type)));
  const failed = item('failed', { status: 'needs_review', attempts: attemptLimits.core });
  const query = { eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn() };
  const select = jest.fn(() => query);
  (supabaseAdmin.from as jest.Mock).mockReturnValue({ select });
  const snapshot = async (items: BacklogItem[]) => {
    query.maybeSingle.mockResolvedValue({ data: { backlog: { items }, type }, error: null });
    return loadCycleInterventionState('req', 'site');
  };
  expect(await snapshot([failed, item('independent')])).toMatchObject({
    hasRunnableBacklogWork: true, technicalReviewRequired: false,
  });
  expect(select).toHaveBeenCalledWith('backlog,type');
  expect(await snapshot([failed, item('dependent', { depends_on: ['failed'] })])).toMatchObject({ hasRunnableBacklogWork: false });
  expect(await snapshot([failed, item('blocked', { blocked_by: [decision] })])).toMatchObject({
    hasRunnableBacklogWork: false, userDecisionBlockers: [decision],
  });
  expect(await snapshot([failed, item('exhausted', { attempts: attemptLimits.core })])).toMatchObject({ hasRunnableBacklogWork: false });
  expect(await snapshot([failed, item('ornamental', { tier: 'ornamental', attempts: attemptLimits.ornamental })]))
    .toMatchObject({ hasRunnableBacklogWork: false });
  expect(await snapshot([failed, item('bounded', { attempts: attemptLimits.core - 1 })])).toMatchObject({ hasRunnableBacklogWork: true });
  expect(await snapshot([failed, item('quarantined', { review_quarantine: {
    active: true, kind: 'manual', reason: 'Safety hold', quarantined_at: '2026-10-01T00:00:00Z', external_action_revision: 0,
  } })])).toMatchObject({ hasRunnableBacklogWork: false });
  expect(await snapshot([item('done', { status: 'done' }), item('dependent', { depends_on: ['done'] })]))
    .toMatchObject({ hasRunnableBacklogWork: true });
  expect(await snapshot([])).toEqual({ hasRunnableBacklogWork: false, hasRunnablePlanWork: false, technicalReviewRequired: false, userDecisionBlockers: [] });
  query.maybeSingle.mockResolvedValue({ data: { backlog: null, type }, error: null });
  expect(await loadCycleInterventionState('req', 'site')).toEqual({ hasRunnableBacklogWork: false, hasRunnablePlanWork: false, technicalReviewRequired: false, userDecisionBlockers: [] });
  query.maybeSingle.mockResolvedValue({ data: { backlog: { items: 'unknown' }, type }, error: null });
  expect(await loadCycleInterventionState('req', 'site')).toBeNull();
});

it('checks fresh scoped plan work without reopening stale exhausted or quarantined item links', async () => {
  const items = [item('held', { status: 'needs_review', attempts: 4 }), item('exhausted', { attempts: 100 }),
    item('dependent', { depends_on: ['held'] })];
  const requirement = { eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue({ data: { type: 'app', backlog: { items } }, error: null }) };
  const plans = { eq: jest.fn().mockReturnThis(), is: jest.fn().mockReturnThis(), in: jest.fn().mockReturnThis(), limit: jest.fn() };
  (supabaseAdmin.from as jest.Mock).mockImplementation(table => ({ select: () => table === 'requirements' ? requirement : plans }));
  const snapshot = async (rows: any[]) => {
    plans.limit.mockResolvedValue({ data: rows, error: null });
    return loadCycleInterventionState('req', 'site', 'instance');
  };
  const plan = (steps: any[], metadata = { requirement_id: 'req' }) => ({ steps, metadata });
  expect(await snapshot([plan([{ status: 'pending' }])])).toMatchObject({ hasRunnablePlanWork: true, hasRunnableBacklogWork: false });
  expect(plans.eq).toHaveBeenCalledWith('instance_id', 'instance');
  expect(plans.eq).toHaveBeenCalledWith('site_id', 'site');
  for (const id of ['held', 'exhausted', 'dependent', 'missing']) {
    expect(await snapshot([plan([{ status: 'pending', backlog_item_id: id }])])).toMatchObject({ hasRunnablePlanWork: false });
  }
  expect(await snapshot([plan([{ status: 'failed', retry_count: 2 }])])).toMatchObject({ hasRunnablePlanWork: false });
  for (const hold of [{ infrastructure_intervention_required: true }, { infra_retry_after: '2026-10-01T00:00:00Z' },
    { metadata: { repair_run: { status: 'exhausted' } } }, { metadata: { no_progress_adjudication: { state: 'requested' } } }]) {
    expect(await snapshot([plan([{ status: 'pending', ...hold }])])).toMatchObject({ hasRunnablePlanWork: false });
  }
  expect(await snapshot([plan([{ status: 'pending' }], { requirement_id: 'other' })])).toMatchObject({ hasRunnablePlanWork: false });
  expect(await snapshot([{ steps: [{ status: 'pending' }], metadata: {} }])).toMatchObject({ hasRunnablePlanWork: false });
  expect(await snapshot([{ steps: null }])).toBeNull();
  plans.limit.mockResolvedValue({ data: null, error: true });
  expect(await loadCycleInterventionState('req', 'site', 'instance')).toBeNull();
});

it('reads all explicit requirement runners and only current-instance legacy plans, failing closed on either incomplete snapshot', async () => {
  const requirement = { eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue({
    data: { type: 'app', backlog: { items: [item('held', { status: 'needs_review', attempts: 4 })] } }, error: null,
  }) };
  const query = () => ({ eq: jest.fn().mockReturnThis(), is: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue({ data: [], error: null }) });
  const explicit = query();
  const legacy = query();
  const read = () => {
    (supabaseAdmin.from as jest.Mock)
      .mockReturnValueOnce({ select: () => requirement })
      .mockReturnValueOnce({ select: () => explicit })
      .mockReturnValueOnce({ select: () => legacy });
    return loadCycleInterventionState('req', 'site', 'current-runner');
  };
  explicit.limit.mockResolvedValue({ data: [{ instance_id: 'other-runner', metadata: { requirement_id: 'req' },
    steps: [{ status: 'pending' }] }], error: null });
  expect(await read()).toMatchObject({ hasRunnableBacklogWork: false, hasRunnablePlanWork: true });
  expect(explicit.eq).toHaveBeenCalledWith('site_id', 'site');
  expect(explicit.eq).toHaveBeenCalledWith('metadata->>requirement_id', 'req');
  expect(explicit.eq).not.toHaveBeenCalledWith('instance_id', expect.anything());
  expect(legacy.eq).toHaveBeenCalledWith('instance_id', 'current-runner');
  expect(legacy.eq).toHaveBeenCalledWith('site_id', 'site');
  expect(legacy.is).toHaveBeenCalledWith('metadata->>requirement_id', null);
  for (const incomplete of [explicit, legacy]) {
    for (const result of [{ data: null, error: true }, { data: Array(101).fill({ steps: [] }), error: null },
      { data: [{ steps: null }], error: null }]) {
      incomplete.limit.mockResolvedValueOnce(result);
      expect(await read()).toBeNull();
    }
  }
});