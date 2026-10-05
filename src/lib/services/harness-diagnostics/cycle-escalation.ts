import { createHash } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadHarnessScope, sanitizeHarnessData, type HarnessDiagnosticContext } from './context';
import { deliverHarnessSupportTicket } from './support';
import { cycleCircuitBreakerSchema, loadCycleCircuitBreaker, type CycleCircuitBreaker } from './cycle-circuit-breaker';

export interface CycleTechnicalEscalationResult {
  state: 'recorded' | 'unavailable' | 'not_eligible';
  reason?: string;
  ticket_id?: string;
  email_sent: boolean;
  delivery_state?: string;
}

const UNAVAILABLE = { state: 'unavailable', email_sent: false } as const;
const DEFAULT_REASON = 'Automatic recovery exhausted and no independent work or pending recovery remains; the host circuit breaker stopped this cycle.';
const REQUESTED_ACTION = 'inspect gate/test fixtures and request/response contract; repair under existing guards; reconcile exhausted execution before fresh validation';
const TICKET_COLUMNS = 'id,site_id,requirement_id,instance_id,request_id,decision,item_id,status,reason,payload,contract_snapshot';
const ticketSchema = z.object({
  id: z.string().uuid(), site_id: z.string().uuid(), requirement_id: z.string().uuid(),
  instance_id: z.string().uuid(), request_id: z.string().uuid(),
  decision: z.literal('escalate_support'), item_id: z.null(), status: z.literal('recorded'),
  reason: z.string().min(1), payload: z.record(z.unknown()),
  contract_snapshot: z.object({ backlog_revision: z.number().int().nonnegative(), requirement_updated_at: z.string() }).passthrough(),
}).passthrough();
type Ticket = z.infer<typeof ticketSchema>;

function executionGeneration(metadata: Record<string, unknown> | null | undefined): number | null {
  const value = metadata?.requirement_execution_generation;
  // Legacy requirements start at generation zero; malformed identities fail closed.
  if (value == null) return 0;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  return /^[0-9]{1,9}$/.test(String(value)) ? Number(value) : null;
}

function cycleRequestId(context: HarnessDiagnosticContext, requirementId: string, generation: number): string {
  // UUID v5 (URL namespace). Never include reporting timestamps, reason, tools or CAS tokens.
  const bytes = createHash('sha1')
    .update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'))
    .update(JSON.stringify(['urn:uncodie:harness:cycle-technical-escalation:v1', context.siteId.toLowerCase(),
      requirementId.toLowerCase(), context.instanceId.toLowerCase(), generation]))
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function scopedTicket(value: unknown, context: HarnessDiagnosticContext, requirementId: string): Ticket | null {
  const parsed = ticketSchema.safeParse(value);
  if (!parsed.success || parsed.data.site_id !== context.siteId || parsed.data.requirement_id !== requirementId ||
    parsed.data.instance_id !== context.instanceId) return null;
  // Historical/manual tickets are not circuit-break receipts and cannot be adopted as one.
  const breaker = cycleCircuitBreakerSchema.safeParse(parsed.data.payload.circuit_breaker);
  if (!breaker.success) return null;
  return parsed.data;
}

async function exactTicket(context: HarnessDiagnosticContext, requirementId: string, requestId: string): Promise<Ticket | null> {
  const { data, error } = await supabaseAdmin.from('requirement_harness_decisions').select(TICKET_COLUMNS)
    .eq('request_id', requestId).eq('requirement_id', requirementId)
    .eq('site_id', context.siteId).eq('instance_id', context.instanceId).maybeSingle();
  if (error) throw new Error('Ticket lookup unavailable.');
  if (data == null) return null;
  const ticket = scopedTicket(data, context, requirementId);
  if (!ticket || ticket.request_id !== requestId) throw new Error('Invalid ticket receipt.');
  return ticket;
}

function timestampMicros(value: string): bigint | null {
  // SQL compares timestamptz instants, not JSON text. Preserve sub-millisecond CAS precision.
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  return Number.isFinite(seconds) ? BigInt(seconds) * BigInt(1000) + BigInt((match[2] || '').padEnd(6, '0')) : null;
}

function proofFingerprint({ requirement_updated_at: _, ...proof }: CycleCircuitBreaker): string {
  // Report-only timestamps can move. Semantic work/plan/recovery changes cannot.
  // PostgreSQL jsonb reorders object keys; row/receipt order is not authority either.
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
    return value;
  };
  return JSON.stringify(canonical(proof));
}

async function snapshotTicket(context: HarnessDiagnosticContext, requirementId: string, revision: number, updatedAt: string): Promise<Ticket | null> {
  // The SQL snapshot guard spans callers. Never adopt another instance's receipt.
  const { data, error } = await supabaseAdmin.from('requirement_harness_decisions').select(TICKET_COLUMNS)
    .eq('requirement_id', requirementId).eq('site_id', context.siteId).eq('instance_id', context.instanceId)
    .eq('decision', 'escalate_support').is('item_id', null)
    .contains('contract_snapshot', { backlog_revision: revision }).order('created_at', { ascending: false }).limit(50);
  if (error || !Array.isArray(data)) throw new Error('Snapshot ticket lookup unavailable.');
  const instant = timestampMicros(updatedAt);
  if (instant === null) return null;
  const matches = data.map(value => scopedTicket(value, context, requirementId)).filter((ticket): ticket is Ticket =>
    !!ticket && ticket.contract_snapshot.backlog_revision === revision &&
    timestampMicros(ticket.contract_snapshot.requirement_updated_at) === instant);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Host-only circuit break, not a model/tool decision or execution admission.
 * A generic technical hold/reason is insufficient: fresh canonical state must prove exhaustion.
 * Only the diagnostic RPC and existing delivery service may write; no repair is executed.
 */
export async function ensureCycleTechnicalEscalation(
  context: HarnessDiagnosticContext,
  params: { reason?: string | null; assertCurrent?: () => Promise<void> },
): Promise<CycleTechnicalEscalationResult> {
  // Ownership errors must escape, including errors other than Error instances.
  await params.assertCurrent?.();
  let requirement: Awaited<ReturnType<typeof loadHarnessScope>>['requirement'];
  let generation: number;
  let requestId: string;
  let ticket: Ticket | null;
  let proof: CycleCircuitBreaker;
  try {
    const scope = await loadHarnessScope(context);
    ({ requirement } = scope);
    const currentGeneration = executionGeneration(requirement.metadata);
    if (requirement.status !== 'blocked' || currentGeneration === null) return { ...UNAVAILABLE };
    const evaluation = await loadCycleCircuitBreaker(scope);
    if (evaluation.state !== 'eligible') return { state: evaluation.state, reason: evaluation.reason, email_sent: false };
    proof = evaluation.proof;
    generation = currentGeneration;
    requestId = cycleRequestId(context, requirement.id, generation);
    // Replay precedes payload construction: later host reasons must never rewrite a receipt.
    ticket = await exactTicket(context, requirement.id, requestId);
  } catch {
    return { ...UNAVAILABLE };
  }

  if (!ticket) {
    const revision = requirement.backlog_revision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || timestampMicros(requirement.updated_at) === null) return { ...UNAVAILABLE };
    // Strip URL userinfo before the shared email redactor can consume its @ delimiter.
    const hostReason = (params.reason || DEFAULT_REASON).replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
    const reason = (sanitizeHarnessData(hostReason) as string)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 2000) || DEFAULT_REASON;
    const payload = {
      circuit_breaker: proof,
      evidence_log_ids: [],
      verification: 'Inspect canonical action receipts and reproduce the failed gate under existing guards before fresh validation; this escalation verifies no repair or acceptance.',
      impact: 'Requirement execution is blocked pending internal technical review. No customer product approval is requested.',
      requested_action: REQUESTED_ACTION,
      attempted_alternatives: ['Automatic execution stopped at its bounded recovery limit; inspect canonical action receipts before attributing individual repairs.'],
    };
    await params.assertCurrent?.();
    try {
      const { data, error } = await supabaseAdmin.rpc('record_harness_diagnostic_decision', {
        p_site_id: context.siteId, p_requirement_id: requirement.id, p_instance_id: context.instanceId,
        p_expected_backlog_revision: revision, p_expected_updated_at: requirement.updated_at,
        p_request_id: requestId, p_decision: 'escalate_support', p_item_id: null, p_reason: reason, p_payload: payload,
      });
      if (error) {
        if (!['harness_support_ticket_exists', 'harness_decision_request_conflict'].includes(error.message)) return { ...UNAVAILABLE };
        // A concurrent call may have committed the same request with its original reason.
        ticket = await exactTicket(context, requirement.id, requestId);
        if (!ticket && error.message === 'harness_support_ticket_exists') {
          ticket = await snapshotTicket(context, requirement.id, revision, requirement.updated_at);
        }
      } else {
        ticket = scopedTicket(data?.decision || data?.receipt || data, context, requirement.id);
        if (ticket?.request_id !== requestId) return { ...UNAVAILABLE };
      }
      if (!ticket) return { ...UNAVAILABLE };
    } catch {
      // An uncertain commit is not permission to mint a different request or claim a ticket.
      return { ...UNAVAILABLE };
    }
  }

  try {
    const current = await loadHarnessScope(context);
    if (current.requirement.id !== requirement.id || current.requirement.status !== 'blocked' ||
      executionGeneration(current.requirement.metadata) !== generation) return { ...UNAVAILABLE };
    const evaluation = await loadCycleCircuitBreaker(current);
    if (evaluation.state !== 'eligible') return { state: evaluation.state, reason: evaluation.reason, email_sent: false };
    // A report timestamp may change, but changed plans/recovery/exhaustion cannot reuse a stale decision.
    if (proofFingerprint(evaluation.proof) !== proofFingerprint(proof) ||
        proofFingerprint(ticket.payload.circuit_breaker as CycleCircuitBreaker) !== proofFingerprint(proof)) return { ...UNAVAILABLE };
  } catch {
    return { ...UNAVAILABLE };
  }
  await params.assertCurrent?.();
  try {
    const delivery = await deliverHarnessSupportTicket(ticket, context);
    return { state: 'recorded', ticket_id: ticket.id, email_sent: delivery.email_sent === true, delivery_state: delivery.state };
  } catch {
    // Storage succeeded; email failure cannot erase the receipt or prove delivery.
    return { state: 'recorded', ticket_id: ticket.id, email_sent: false, delivery_state: 'unavailable' };
  }
}