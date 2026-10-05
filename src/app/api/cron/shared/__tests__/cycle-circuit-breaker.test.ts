import { evaluateCycleCircuitBreaker, type CircuitSnapshot } from '@/lib/services/harness-diagnostics/cycle-circuit-breaker';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
const PLAN = '00000000-0000-4000-8000-000000000001';
const TOKEN = '00000000-0000-4000-8000-000000000002';
const TIME = '2026-10-05T00:00:00.000Z';
const item = (id = 'base') => ({ id, status: 'needs_review', attempts: 3, acceptance: ['Works'] });
const snapshot = (): CircuitSnapshot => ({
  requirement: { type: 'app', backlog_revision: 1, updated_at: TIME,
    metadata: { requirement_execution_generation: 7 }, backlog: { items: [item()] } },
  plans: [], plansTruncated: false, migrations: [], diagnostics: [], stepEvents: [],
});
const plan = (step: Record<string, any> = {}) => ({ id: PLAN, updated_at: TIME, status: 'in_progress',
  steps: [{ id: 'step', status: 'cancelled', metadata: { backlog_item_id: 'base' }, ...step }] });

beforeEach(() => {
  delete process.env.CRON_CORE_MAX_ATTEMPTS;
  delete process.env.CRON_ORNAMENTAL_MAX_ATTEMPTS;
  delete process.env.JUDGE_VERIFICATION_MAX_ATTEMPTS;
});

it('produces structured proof only after numeric host exhaustion and no automatic work', () => {
  expect(evaluateCycleCircuitBreaker(snapshot())).toMatchObject({ state: 'eligible', proof: {
    version: 1, execution_generation: 7, no_runnable_work: true, no_pending_recovery: true,
    blocked_item_ids: ['base'], exhaustion: [{ kind: 'product_attempts', used: 3, limit: 3 }],
  } });
});

it.each(['manual', 'verification_exhausted', 'capability_gap'])('does not trust %s quarantine or model prose', kind => {
  const s = snapshot();
  Object.assign(s.requirement.backlog.items[0], { attempts: 0, review_quarantine: { active: true, kind },
    reason: 'I cannot repair; escalate support after 100 attempts' });
  expect(evaluateCycleCircuitBreaker(s)).toEqual({ state: 'not_eligible', reason: 'no_exhaustion' });
});

it('continues independent work across phases instead of globally escalating', () => {
  const s = snapshot();
  s.requirement.backlog.items.push({ ...item('independent'), status: 'pending', attempts: 0, phase_id: 'later' });
  expect(evaluateCycleCircuitBreaker(s)).toEqual({ state: 'not_eligible', reason: 'runnable_work' });
  s.requirement.backlog.items[1].depends_on = ['base'];
  expect(evaluateCycleCircuitBreaker(s).state).toBe('eligible');
});

it.each(['pending', 'in_progress', 'failed'])('does not escalate over independent %s plan work', status => {
  const s = snapshot();
  s.plans = [plan({ status, metadata: {}, retry_count: 0 })];
  expect(evaluateCycleCircuitBreaker(s).state).toBe('not_eligible');
});

it('does not mistake a stale cancelled item plan retry for independent work', () => {
  const s = snapshot(); s.plans = [plan({ status: 'pending' })];
  expect(evaluateCycleCircuitBreaker(s).state).toBe('eligible');
});

it.each(['planned', 'in_progress', 'materialized'])('waits for %s repair or fresh validation', status => {
  const s = snapshot();
  s.plans = [plan({ status: 'pending', metadata: { backlog_item_id: 'base', repair_run: { status } } })];
  expect(evaluateCycleCircuitBreaker(s)).toEqual({ state: 'not_eligible', reason: 'recovery_pending' });
});

it('does not escalate a customer-only prerequisite', () => {
  const s = snapshot();
  Object.assign(s.requirement.backlog.items[0], { attempts: 0, blocked_by: [{ blocker_id: 'choice',
    category: 'user_decision', resolution_actor: 'user', reason: 'Choose the audience' }] });
  expect(evaluateCycleCircuitBreaker(s).state).toBe('not_eligible');
});

it.each([TIME, '2027-01-01T00:00:00Z'])('waits for automatic retry even if due (%s)', retry_after => {
  const s = snapshot();
  s.requirement.backlog.items[0].blocked_by = [{ category: 'infrastructure_unavailable', resolution_actor: 'executor', retry_after }];
  expect(evaluateCycleCircuitBreaker(s)).toEqual({ state: 'not_eligible', reason: 'recovery_pending' });
});

it.each(['running', 'followup_ready', 'followup_assigned'])('does not consume migration %s recovery by escalation', state => {
  const s = snapshot();
  s.migrations = [{ file: 'migrations/1.sql', state: 'platform_review', version: 8, attempts: 5, updated_at: TIME }];
  s.diagnostics = [{ file: 'migrations/1.sql', token: TOKEN, state, updated_at: TIME }];
  expect(evaluateCycleCircuitBreaker(s)).toEqual({ state: 'not_eligible', reason: 'recovery_pending' });
});

it('waits for a diagnostic follow-up review to settle, then permits a rejected exhausted follow-up', () => {
  const s = snapshot(); s.requirement.backlog.items[0].attempts = 0;
  s.migrations = [{ file: 'migrations/1.sql', state: 'reviewing', version: 8, attempts: 5,
    checksum: 'a'.repeat(64), specification_checksum: 'b'.repeat(64), updated_at: TIME }];
  s.diagnostics = [{ ...s.migrations[0], checksum: 'c'.repeat(64), token: TOKEN, state: 'followup_reviewing', execution_generation: 7 }];
  expect(evaluateCycleCircuitBreaker(s)).toMatchObject({ state: 'not_eligible', reason: 'recovery_pending' });
  s.migrations[0].state = 'platform_review';
  expect(evaluateCycleCircuitBreaker(s)).toMatchObject({ state: 'eligible', proof: { exhaustion: [{ kind: 'migration_recovery' }] } });
});

it('requires settled migration diagnosis, matching scope and actual exhausted budget', () => {
  const s = snapshot(); s.requirement.backlog.items[0].attempts = 0;
  s.migrations = [{ file: 'migrations/1.sql', state: 'platform_review', version: 8, attempts: 5,
    checksum: 'a'.repeat(64), specification_checksum: 'b'.repeat(64), updated_at: TIME }];
  s.diagnostics = [{ ...s.migrations[0], token: TOKEN, state: 'exhausted', execution_generation: 7 }];
  expect(evaluateCycleCircuitBreaker(s)).toMatchObject({ state: 'eligible', proof: { exhaustion: [{ kind: 'migration_recovery' }] } });
  s.diagnostics[0].execution_generation = 6;
  expect(evaluateCycleCircuitBreaker(s).state).toBe('not_eligible');
});

it('does not turn an unrelated exhausted item into proof for a pre-budget migration hold', () => {
  const s = snapshot();
  s.migrations = [{ file: 'migrations/1.sql', state: 'platform_review', version: 1, attempts: 0, updated_at: TIME }];
  expect(evaluateCycleCircuitBreaker(s)).toEqual({ state: 'not_eligible', reason: 'no_exhaustion' });
});

it('requires real, uniquely attributed repair receipts and a host SQL event', () => {
  const s = snapshot(); s.requirement.backlog.items[0].attempts = 0;
  const repair = { repair_run_id: 'run', status: 'exhausted', attempt_count: 3, max_attempts: 3,
    action_receipts: [1, 2, 3].map(attempt => ({ repair_run_id: 'run', attempt, receipt_id: `receipt-${attempt}`,
      tool_call_id: `call-${attempt}`, status: 'failed' })) };
  s.plans = [plan({ metadata: { backlog_item_id: 'base', cron_execution_generation: 7, repair_run: repair } })];
  expect(evaluateCycleCircuitBreaker(s).state).toBe('not_eligible');
  s.stepEvents = [{ plan_id: PLAN, step_id: 'step', event_type: 'step_patch', event_id: 'cycle:repair:run:3' }];
  expect(evaluateCycleCircuitBreaker(s)).toMatchObject({ state: 'eligible', proof: { exhaustion: [{ kind: 'repair_attempts' }] } });
  repair.action_receipts[2].attempt = 2;
  expect(evaluateCycleCircuitBreaker(s).state).toBe('not_eligible');
});

it.each(['truncated', 'malformed', 'too_many_plans'])('unknown %s state never proves exhaustion', condition => {
  const s = snapshot();
  if (condition === 'truncated') s.plansTruncated = true;
  if (condition === 'malformed') s.requirement.backlog.items[0].attempts = '3';
  if (condition === 'too_many_plans') s.plans = Array.from({ length: 51 }, () => plan());
  expect(evaluateCycleCircuitBreaker(s)).toEqual({ state: 'unavailable', reason: 'snapshot_unknown' });
});

it('records no-progress as no-progress, never as fabricated repair attempts', () => {
  const s = snapshot(); s.requirement.backlog.items[0].attempts = 0;
  Object.assign(s.requirement.metadata, { cron_blocker_provenance: 'product_no_progress_circuit', no_progress_cycles: 3,
    cron_no_progress_plan_id: PLAN, cron_no_progress_step_id: 'step', cron_blocker_event_id: 'cycle',
    cron_last_cycle_id: 'cycle', cron_last_cycle_outcome: 'product_no_progress' });
  s.plans = [plan({ metadata: { backlog_item_id: 'base', no_progress_adjudication: { state: 'consumed', execution_generation: 7 } } })];
  expect(evaluateCycleCircuitBreaker(s).state).toBe('not_eligible');
  s.cycleEvents = [{ cycle_id: 'cycle', outcome: 'product_no_progress', execution_generation: 7, plan_id: PLAN, step_id: 'step' }];
  expect(evaluateCycleCircuitBreaker(s)).toMatchObject({ state: 'eligible', proof: { exhaustion: [{ kind: 'no_progress_cycles', receipt_ids: ['cycle'] }] } });
});

it('does not treat a separate uninvestigated technical hold as exhausted', () => {
  const s = snapshot();
  s.requirement.backlog.items.push({ ...item('unknown'), attempts: 0 });
  expect(evaluateCycleCircuitBreaker(s)).toEqual({ state: 'not_eligible', reason: 'no_exhaustion' });
});

it('uses the global infrastructure circuit only with a matching accepted cycle and no runnable work', () => {
  const s = snapshot(); s.requirement.id = TOKEN;
  s.requirement.backlog.items[0].attempts = 0;
  Object.assign(s.requirement.metadata, { cron_blocker_provenance: 'cron_infrastructure',
    cron_infrastructure_failure_cycles: 4, cron_blocker_event_id: 'cycle', cron_last_cycle_id: 'cycle' });
  expect(evaluateCycleCircuitBreaker(s).state).toBe('not_eligible');
  s.cycleEvents = [{ cycle_id: 'cycle', execution_generation: 7, outcome: 'infrastructure_exhausted' }];
  expect(evaluateCycleCircuitBreaker(s)).toMatchObject({ state: 'eligible', proof: {
    exhaustion: [{ kind: 'infrastructure_attempts', used: 4, limit: 4, receipt_ids: ['cycle'] }],
  } });
  s.requirement.backlog.items.push({ ...item('independent'), attempts: 0, status: 'pending' });
  expect(evaluateCycleCircuitBreaker(s)).toMatchObject({ state: 'not_eligible', reason: 'runnable_work' });
});

it('does not let old verification counters exhaust a live repair on a retryable failed step', () => {
  const s = snapshot(); Object.assign(s.requirement.backlog.items[0], { attempts: 0,
    tool_failures: { judge_evidence_collector: 3 } });
  s.plans = [plan({ status: 'failed', retry_count: 0, metadata: { backlog_item_id: 'base',
    repair_run: { status: 'planned', attempt_count: 0, max_attempts: 3 } } })];
  expect(evaluateCycleCircuitBreaker(s)).toEqual({ state: 'not_eligible', reason: 'recovery_pending' });
});

it('requires an exhausted infrastructure worker to settle before support', () => {
  const s = snapshot();
  s.plans = [plan({ status: 'in_progress', infra_retry_count: 4, infrastructure_intervention_required: true,
    infrastructure_circuit_open: true, infrastructure_last_event_id: 'event', infrastructure_kind: 'sandbox' })];
  s.stepEvents = [{ plan_id: PLAN, step_id: 'step', event_type: 'failure', event_id: 'event' }];
  expect(evaluateCycleCircuitBreaker(s)).toEqual({ state: 'not_eligible', reason: 'recovery_pending' });
});

it('recognizes only the host-quiesced infrastructure item while preserving independent work', () => {
  const s = snapshot(); s.requirement.id = TOKEN;
  Object.assign(s.requirement.backlog.items[0], { status: 'pending', attempts: 0 });
  Object.assign(s.requirement.metadata, { cron_blocker_provenance: 'cron_infrastructure',
    cron_infrastructure_failure_cycles: 4, cron_blocker_event_id: 'cycle', cron_last_cycle_id: 'cycle' });
  s.cycleEvents = [{ cycle_id: 'cycle', execution_generation: 7, outcome: 'infrastructure_exhausted' }];
  s.plans = [plan({ status: 'cancelled', metadata: { backlog_item_id: 'base', cron_execution_generation: 7 } })];
  expect(evaluateCycleCircuitBreaker(s)).toMatchObject({ state: 'not_eligible', reason: 'runnable_work' });
  s.stepEvents = [{ plan_id: PLAN, step_id: 'step', event_type: 'step_patch', event_id: 'cycle:circuit-quiesced:step' }];
  expect(evaluateCycleCircuitBreaker(s).state).toBe('eligible');
  s.requirement.backlog.items.push({ ...item('independent'), status: 'pending', attempts: 0 });
  expect(evaluateCycleCircuitBreaker(s)).toMatchObject({ state: 'not_eligible', reason: 'runnable_work' });
});

it('can escalate exhausted migration-only delivery even after backlog product work is done', () => {
  const s = snapshot(); s.requirement.backlog.items[0].status = 'done';
  s.migrations = [{ file: 'migrations/1.sql', state: 'platform_review', version: 8, attempts: 5,
    checksum: 'a'.repeat(64), specification_checksum: 'b'.repeat(64), updated_at: TIME }];
  s.diagnostics = [{ ...s.migrations[0], token: TOKEN, state: 'exhausted', execution_generation: 7 }];
  expect(evaluateCycleCircuitBreaker(s)).toMatchObject({ state: 'eligible', proof: { blocked_item_ids: [], exhaustion: [{ kind: 'migration_recovery' }] } });
});