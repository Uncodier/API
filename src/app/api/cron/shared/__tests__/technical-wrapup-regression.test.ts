import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadCycleInterventionState } from '@/lib/services/cycle-wrapup-state';
import { buildCycleWrapUpSystemPrompt, feedbackRequiredBacklogItems, technicalReviewBacklogItems } from '@/lib/services/cycle-wrapup-prompt';
import { reconcileBacklogBlockedBy, requiresUserAction } from '@/lib/services/requirement-backlog-blockers';
import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import { buildRuntimeTargetPlan, evaluateRuntimeProbe } from '../step-probe-policy';

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