import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { PLAN_STEP_MAX_RETRIES } from '@/lib/helpers/plan-status';
import { isBacklogItemRunnable, isCustomerDecisionBlocker } from '../requirement-backlog-blockers';
import { classifyRequirementType, getFlow, productAttemptLimits } from '../requirement-flows';
import { judgeVerificationAttemptLimit } from '@/app/api/cron/shared/judge-verification-policy';
import type { HarnessScope } from './context';

const counter = z.number().int().nonnegative().max(1_000_000);
const identifier = z.string().min(1).max(512);
const timestamp = z.string().datetime({ offset: true });
const exhaustionSchema = z.object({
  kind: z.enum(['repair_attempts', 'product_attempts', 'verification_attempts', 'infrastructure_attempts', 'no_progress_cycles', 'migration_recovery']),
  target_id: identifier, used: counter, limit: counter.refine(value => value > 0),
  receipt_ids: z.array(identifier).max(100),
}).strict().refine(value => value.used >= value.limit);

/** Persisted with the ticket, never accepted as a model argument. */
export const cycleCircuitBreakerSchema = z.object({
  version: z.literal(1), execution_generation: counter, backlog_revision: counter,
  requirement_updated_at: timestamp,
  no_runnable_work: z.literal(true), no_pending_recovery: z.literal(true),
  blocked_item_ids: z.array(identifier).max(200),
  exhaustion: z.array(exhaustionSchema).min(1).max(100),
  plan_versions: z.array(z.object({ id: z.string().uuid(), updated_at: timestamp }).strict()).max(50),
  migration_versions: z.array(z.object({ file: identifier, version: counter, state: identifier, updated_at: timestamp }).strict()).max(100),
  diagnostic_versions: z.array(z.object({ file: identifier, token: z.string().uuid(), state: identifier, updated_at: timestamp }).strict()).max(100),
}).strict();
export type CycleCircuitBreaker = z.infer<typeof cycleCircuitBreakerSchema>;
type Exhaustion = z.infer<typeof exhaustionSchema>;
export type CircuitEvaluation =
  | { state: 'eligible'; proof: CycleCircuitBreaker }
  | { state: 'not_eligible'; reason: 'no_technical_work' | 'recovery_pending' | 'runnable_work' | 'no_exhaustion' }
  | { state: 'unavailable'; reason: 'snapshot_unknown' };
const UNKNOWN = { state: 'unavailable', reason: 'snapshot_unknown' } as const;
const denied = (reason: Extract<CircuitEvaluation, { state: 'not_eligible' }>['reason']): CircuitEvaluation => ({ state: 'not_eligible', reason });
const integer = (value: unknown): value is number => counter.safeParse(value).success;
const terminal = (status: unknown) => ['completed', 'cancelled', 'canceled'].includes(String(status));
type Row = Record<string, any>;

export interface CircuitSnapshot {
  requirement: Row;
  plans: Row[];
  plansTruncated: boolean;
  migrations: Row[];
  diagnostics: Row[];
  stepEvents: Row[];
  cycleEvents?: Row[];
}

/** Pure decision over host-loaded state. Reasons, quarantine labels and model verdicts are never exhaustion evidence. */
export function evaluateCycleCircuitBreaker(snapshot: CircuitSnapshot): CircuitEvaluation {
  const { requirement: req, plans, migrations, diagnostics, stepEvents } = snapshot;
  if (snapshot.plansTruncated || !Array.isArray(req.backlog?.items) || plans.length > 50 ||
      migrations.length > 100 || diagnostics.length > 100 || stepEvents.length > 1000) return UNKNOWN;
  const items: Row[] = req.backlog.items;
  if (items.some(item => !item || typeof item.id !== 'string' || !Array.isArray(item.acceptance) ||
      !integer(item.attempts ?? 0) || (item.blocked_by != null && !Array.isArray(item.blocked_by)))) return UNKNOWN;
  if (new Set(items.map(item => item.id)).size !== items.length) return UNKNOWN;
  const generation = req.metadata?.requirement_execution_generation ?? 0;
  const generationNumber = typeof generation === 'string' && /^\d{1,9}$/.test(generation) ? Number(generation) : generation;
  if (!integer(generationNumber)) return UNKNOWN;
  const outstanding = items.filter(item => item.status !== 'done');
  if (!outstanding.length && !migrations.some(row => !['validated', 'transferred'].includes(row.state))) return denied('no_technical_work');
  const byId = new Map(items.map(item => [item.id, item]));
  const flowLimits = productAttemptLimits(getFlow(classifyRequirementType(req.type)));
  const exhaustion: Exhaustion[] = [];
  const exhaustedItems = new Set<string>();
  const exhaustedSteps = new Set<string>();
  const add = (entry: Exhaustion, itemId?: string, stepId?: string) => {
    exhaustion.push(entry);
    if (itemId) exhaustedItems.add(itemId);
    if (stepId) exhaustedSteps.add(stepId);
  };
  const metadata = req.metadata || {};
  const infrastructureCycle = snapshot.cycleEvents?.find(event => event.cycle_id === metadata.cron_blocker_event_id &&
    event.execution_generation === generationNumber && ['infrastructure_retry', 'infrastructure_exhausted'].includes(event.outcome));
  const infrastructureCircuit = metadata.cron_blocker_provenance === 'cron_infrastructure' &&
    integer(metadata.cron_infrastructure_failure_cycles) && metadata.cron_infrastructure_failure_cycles >= 4 &&
    metadata.cron_blocker_event_id === metadata.cron_last_cycle_id && infrastructureCycle;
  for (const item of outstanding) {
    // Self-heal stops product defects at three; the declarative scheduler may impose a lower limit.
    const schedulerLimit = item.tier === 'ornamental' ? flowLimits.ornamental : flowLimits.core;
    const limit = item.status === 'needs_review' ? Math.min(3, schedulerLimit) : schedulerLimit;
    if (item.attempts >= limit) add({ kind: 'product_attempts', target_id: item.id,
      used: item.attempts, limit, receipt_ids: [] }, item.id);
    for (const name of ['judge_evidence_collector', 'judge_acceptance_contract']) {
      const used = item.tool_failures?.[name];
      if (item.status === 'needs_review' && integer(used) && used >= judgeVerificationAttemptLimit()) add({ kind: 'verification_attempts', target_id: item.id,
        used, limit: judgeVerificationAttemptLimit(), receipt_ids: [] }, item.id);
    }
    // A pending automatic retry is still recovery, even if its timestamp is already due.
    if (item.blocked_by?.some((blocker: Row) => blocker && !isCustomerDecisionBlocker(blocker as any) && blocker.retry_after != null)) {
      return denied('recovery_pending');
    }
    if (['critic_review', 'judge_review'].includes(item.status) || item.plan_cancellation_pending) return denied('recovery_pending');
  }
  for (const plan of plans) {
    if (!z.string().uuid().safeParse(plan.id).success || !timestamp.safeParse(plan.updated_at).success || !Array.isArray(plan.steps)) return UNKNOWN;
    if (plan.metadata?.workflow_template) continue;
    for (const step of plan.steps) {
      if (!step || typeof step.id !== 'string') return UNKNOWN;
      // Exhausted accounting does not prove a live worker has stopped.
      if (step.status === 'in_progress') return denied('recovery_pending');
      const itemId = step.metadata?.backlog_item_id || step.backlog_item_id;
      const item = byId.get(itemId);
      const key = `${plan.id}:${step.id}`;
      const repair = step.metadata?.repair_run;
      if (step.metadata?.no_progress_adjudication?.state === 'requested' ||
          (step.infra_retry_after && !step.infrastructure_intervention_required)) return denied('recovery_pending');
      if (item?.status === 'done') continue;
      if (repair && ['planned', 'in_progress', 'materialized'].includes(repair.status) && !terminal(step.status)) return denied('recovery_pending');
      if (repair?.status === 'exhausted' && integer(repair.attempt_count) && integer(repair.max_attempts) &&
          repair.max_attempts > 0 && repair.attempt_count >= repair.max_attempts && Array.isArray(repair.action_receipts) &&
          step.metadata?.cron_execution_generation === generationNumber) {
        const receipts = repair.action_receipts.filter((receipt: Row) => receipt?.repair_run_id === repair.repair_run_id &&
          integer(receipt.attempt) && receipt.attempt > 0 && receipt.attempt <= repair.attempt_count &&
          typeof receipt.receipt_id === 'string' && typeof receipt.tool_call_id === 'string' &&
          ['succeeded', 'failed', 'unknown'].includes(receipt.status));
        const witness = stepEvents.find(event => event.plan_id === plan.id && event.step_id === step.id &&
          event.event_type === 'step_patch' && typeof event.event_id === 'string' &&
          event.event_id.endsWith(`:repair:${repair.repair_run_id}:${repair.attempt_count}`));
        if (witness && new Set(receipts.map((receipt: Row) => receipt.attempt)).size >= repair.max_attempts &&
            new Set(receipts.map((receipt: Row) => receipt.receipt_id)).size === receipts.length) {
          add({ kind: 'repair_attempts', target_id: key, used: repair.attempt_count, limit: repair.max_attempts,
            receipt_ids: [witness.event_id, ...receipts.map((receipt: Row) => receipt.receipt_id)].slice(0, 100) }, itemId, key);
        }
      }
      if (step.infrastructure_circuit_open === true && step.infrastructure_intervention_required === true &&
          integer(step.infra_retry_count) && step.infra_retry_count >= 4 && step.infrastructure_kind !== 'deployment') {
        const witness = stepEvents.find(event => event.plan_id === plan.id && event.step_id === step.id &&
          event.event_id === step.infrastructure_last_event_id && event.event_type === 'failure');
        if (witness) add({ kind: 'infrastructure_attempts', target_id: key, used: step.infra_retry_count, limit: 4,
          receipt_ids: [witness.event_id] }, itemId, key);
      }
      const meta = req.metadata || {};
      if (meta.cron_blocker_provenance === 'product_no_progress_circuit' && integer(meta.no_progress_cycles) && meta.no_progress_cycles >= 3 &&
          meta.cron_no_progress_plan_id === plan.id && meta.cron_no_progress_step_id === step.id &&
          step.metadata?.no_progress_adjudication?.execution_generation === generationNumber &&
          step.metadata.no_progress_adjudication.state === 'consumed' && meta.cron_blocker_event_id === meta.cron_last_cycle_id &&
          meta.cron_last_cycle_outcome === 'product_no_progress' && snapshot.cycleEvents?.some(event =>
            event.cycle_id === meta.cron_last_cycle_id && event.outcome === 'product_no_progress' &&
            event.execution_generation === generationNumber && event.plan_id === plan.id && event.step_id === step.id)) {
        add({ kind: 'no_progress_cycles', target_id: key, used: meta.no_progress_cycles, limit: 3,
          receipt_ids: [meta.cron_blocker_event_id] }, itemId, key);
      }
    }
  }
  for (const row of migrations) {
    if (['validated', 'transferred'].includes(row.state)) continue;
    const diagnostic = diagnostics.find(entry => entry.file === row.file);
    const settledFollowup = row.state === 'platform_review' && diagnostic?.state === 'followup_reviewing';
    if (['reviewing', 'validation_pending', 'correction_required'].includes(row.state) ||
        (diagnostic && diagnostic.state !== 'exhausted' && !settledFollowup)) return denied('recovery_pending');
    if (row.state === 'platform_review' && integer(row.attempts) && row.attempts >= 5 && diagnostic &&
        (diagnostic.state === 'exhausted' || settledFollowup) &&
        diagnostic.execution_generation === generationNumber && diagnostic.specification_checksum === row.specification_checksum &&
        (settledFollowup || diagnostic.checksum === row.checksum)) add({ kind: 'migration_recovery', target_id: row.file, used: row.attempts, limit: 5,
          receipt_ids: [diagnostic.token] });
    else return denied('no_exhaustion');
  }
  if (diagnostics.some(row => row.state !== 'exhausted' && !migrations.some(migration => migration.file === row.file &&
      (['validated', 'transferred'].includes(migration.state) ||
        (migration.state === 'platform_review' && row.state === 'followup_reviewing'))))) return denied('recovery_pending');
  // A global infrastructure circuit attests failed infrastructure cycles, not product repairs.
  // It cannot close a deployment wait that still has an automatic recovery path.
  if (infrastructureCircuit && !plans.some(plan => plan.steps.some((step: Row) => step.infrastructure_kind === 'deployment' &&
      !['completed', 'cancelled'].includes(step.status)))) {
    add({ kind: 'infrastructure_attempts', target_id: req.id, used: metadata.cron_infrastructure_failure_cycles, limit: 4,
      receipt_ids: [metadata.cron_blocker_event_id] });
    // The accounting hook may settle only its stopped, generation-owned step.
    // Do not treat its item as newly runnable merely because its status still says pending.
    for (const plan of plans) for (const step of plan.steps) {
      if (step.status !== 'cancelled' || step.metadata?.cron_execution_generation !== generationNumber) continue;
      const event = stepEvents.find(entry => entry.plan_id === plan.id && entry.step_id === step.id &&
        entry.event_type === 'step_patch' && entry.event_id === `${metadata.cron_blocker_event_id}:circuit-quiesced:${step.id}`);
      if (event) {
        const itemId = step.metadata?.backlog_item_id || step.backlog_item_id;
        if (itemId) exhaustedItems.add(itemId);
        exhaustedSteps.add(`${plan.id}:${step.id}`);
      }
    }
  }
  const completedIds = new Set(items.filter(item => item.status === 'done').map(item => item.id));
  if (outstanding.some(item => !exhaustedItems.has(item.id) && isBacklogItemRunnable(item as any, completedIds, flowLimits))) return denied('runnable_work');
  for (const plan of plans) {
    if (plan.metadata?.workflow_template || ['completed', 'cancelled', 'canceled'].includes(plan.status)) continue;
    for (const step of plan.steps) {
      if (step.status === 'in_progress') return denied('recovery_pending');
      const itemId = step.metadata?.backlog_item_id || step.backlog_item_id;
      if (exhaustedItems.has(itemId) || exhaustedSteps.has(`${plan.id}:${step.id}`)) continue;
      const item = byId.get(itemId);
      if (item && !isBacklogItemRunnable(item as any, completedIds, flowLimits)) continue;
      if (['pending', 'in_progress'].includes(step.status) ||
          (step.status === 'failed' && (step.retry_count ?? 0) < PLAN_STEP_MAX_RETRIES)) return denied('runnable_work');
    }
  }
  if (!exhaustion.length) return denied('no_exhaustion');
  // One exhausted branch cannot turn a different, uninvestigated technical hold into support.
  const covered = (item: Row, visiting = new Set<string>()): boolean => {
    if (item.status === 'done' || exhaustedItems.has(item.id)) return true;
    if (visiting.has(item.id)) return false;
    if (item.blocked_by?.some((blocker: Row) => blocker && isCustomerDecisionBlocker(blocker as any))) return true;
    const dependencies: string[] = item.depends_on || [];
    const unfinished = dependencies.map(id => byId.get(id)).filter(dependency => dependency?.status !== 'done');
    if (unfinished.length) return unfinished.every(dependency => dependency && covered(dependency, new Set([...visiting, item.id])));
    return exhaustion.some(entry => entry.kind === 'migration_recovery' ||
      (entry.kind === 'infrastructure_attempts' && entry.target_id === req.id));
  };
  if (outstanding.some(item => !covered(item))) return denied('no_exhaustion');
  const proof = cycleCircuitBreakerSchema.safeParse({
    version: 1, execution_generation: generationNumber, backlog_revision: req.backlog_revision ?? 0,
    requirement_updated_at: req.updated_at, no_runnable_work: true, no_pending_recovery: true,
    blocked_item_ids: outstanding.map(item => item.id).sort(), exhaustion,
    plan_versions: plans.map(plan => ({ id: plan.id, updated_at: plan.updated_at })).sort((a, b) => a.id.localeCompare(b.id)),
    migration_versions: migrations.map(row => ({ file: row.file, version: row.version, state: row.state, updated_at: row.updated_at })).sort((a, b) => a.file.localeCompare(b.file)),
    diagnostic_versions: diagnostics.map(row => ({ file: row.file, token: row.token, state: row.state, updated_at: row.updated_at })).sort((a, b) => a.file.localeCompare(b.file)),
  });
  return proof.success ? { state: 'eligible', proof: proof.data } : UNKNOWN;
}

/** An unavailable/truncated observation never establishes that recovery is exhausted. */
export async function loadCycleCircuitBreaker(scope: HarnessScope): Promise<CircuitEvaluation> {
  try {
    const instanceIds = Array.from(new Set([scope.instance.id, scope.requirement.metadata?.runner_instance_id,
      scope.requirement.metadata?.assistant_origin_instance_id, ...scope.plans.map(plan => plan.instance_id)]
      .filter((id): id is string => typeof id === 'string')));
    const [migrations, diagnostics, events, cycles, legacy] = await Promise.all([
      supabaseAdmin.from('requirement_migration_lifecycle')
        .select('file,version,state,attempts,checksum,specification_checksum,updated_at').eq('requirement_id', scope.requirement.id).limit(101),
      supabaseAdmin.from('requirement_migration_diagnostics')
        .select('file,token,state,execution_generation,checksum,specification_checksum,updated_at').eq('requirement_id', scope.requirement.id).limit(101),
      scope.plans.length ? supabaseAdmin.from('instance_plan_step_infrastructure_events')
        .select('plan_id,step_id,event_id,event_type,details').in('plan_id', scope.plans.map(plan => plan.id)).limit(1001)
        : Promise.resolve({ data: [], error: null }),
      ['product_no_progress_circuit', 'cron_infrastructure'].includes(scope.requirement.metadata?.cron_blocker_provenance)
        ? supabaseAdmin.from('requirement_cron_cycle_outcomes')
          .select('cycle_id,outcome,execution_generation,plan_id,step_id')
          .eq('requirement_id', scope.requirement.id).eq('cycle_id', scope.requirement.metadata.cron_blocker_event_id).limit(1)
        : Promise.resolve({ data: [], error: null }),
      supabaseAdmin.from('instance_plans').select('id,metadata,steps')
        .eq('site_id', scope.requirement.site_id).is('metadata->>requirement_id', null)
        .in('instance_id', instanceIds)
        .in('status', ['pending', 'in_progress', 'active', 'paused']).limit(101),
    ]);
    if ([migrations, diagnostics, events, cycles, legacy].some(result => result.error || !Array.isArray(result.data)) || legacy.data!.length > 100) return UNKNOWN;
    const itemIds = new Set(scope.requirement.backlog?.items?.map((item: Row) => item.id) || []);
    if (legacy.data!.some((plan: Row) => !plan.metadata?.requirement_id && !plan.metadata?.workflow_template &&
        (!Array.isArray(plan.steps) || plan.steps.some((step: Row) =>
          itemIds.has(step.metadata?.backlog_item_id || step.backlog_item_id))))) return denied('recovery_pending');
    return evaluateCycleCircuitBreaker({ requirement: scope.requirement, plans: scope.plans,
      plansTruncated: scope.plansTruncated, migrations: migrations.data!, diagnostics: diagnostics.data!, stepEvents: events.data!, cycleEvents: cycles.data! });
  } catch { return UNKNOWN; }
}