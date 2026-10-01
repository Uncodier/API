import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadHarnessScope, logBelongsToRequirement, sanitizeHarnessData, type HarnessDiagnosticContext } from './context';
import { deliverHarnessSupportTicket } from './support';

const text = (max: number) => z.string().trim().min(1).max(max);
const base = {
  request_id: z.string().uuid(), expected_backlog_revision: z.number().int().nonnegative(),
  expected_updated_at: z.string().datetime({ offset: true }), reason: text(2000),
  evidence_log_ids: z.array(z.string().uuid()).max(12), verification: text(2500),
  thought_process: z.string().max(2000).optional(),
};
export const harnessDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ ...base, decision: z.literal('approve_backlog'), item_id: text(200) }).strict(),
  z.object({ ...base, decision: z.literal('adapt_backlog'), item_id: text(200),
    implementation_instructions: text(8000), equivalence_reason: text(2500),
    acceptance_mapping: z.array(z.object({ criterion_index: z.number().int().min(0).max(39), implementation: text(4000), verification: text(4000) }).strict()).min(1).max(40),
  }).strict(),
  z.object({ ...base, decision: z.literal('escalate_support'), item_id: text(200).optional(),
    impact: text(2500), requested_action: text(2500), attempted_alternatives: z.array(text(1500)).min(1).max(8),
  }).strict(),
]);

export async function decideHarness(context: HarnessDiagnosticContext, raw: unknown) {
  const args = harnessDecisionSchema.parse(raw);
  const { requirement, canAuthor } = await loadHarnessScope(context);
  if (args.decision !== 'escalate_support' && !canAuthor) throw new Error('Only the requirement owner or originating assistant can author its implementation strategy.');
  if (new Set(args.evidence_log_ids).size !== args.evidence_log_ids.length) throw new Error('Evidence IDs must be unique.');
  if (!args.evidence_log_ids.length && args.decision !== 'escalate_support') throw new Error('Read supporting requirement events before deciding.');
  if (args.evidence_log_ids.length) {
    const { data, error } = await supabaseAdmin.from('instance_logs').select('id,details,tool_args')
      .eq('site_id', context.siteId).in('id', args.evidence_log_ids);
    if (error || data?.length !== args.evidence_log_ids.length || data.some(log => !logBelongsToRequirement(log, requirement.id))) {
      throw new Error('Decision cites missing or out-of-scope evidence.');
    }
  }
  // Validate only model-authored content. Canonical acceptance is resolved on the
  // server so redacted criteria never have to be reconstructed by the model.
  if (JSON.stringify(sanitizeHarnessData(args)) !== JSON.stringify(args)) {
    throw new Error('Remove sensitive values from the decision; cite redacted event IDs instead.');
  }
  let mapping: Array<{ criterion: string; implementation: string; verification: string }> | undefined;
  if (args.decision === 'adapt_backlog') {
    const item = requirement.backlog?.items?.find((entry: any) => entry.id === args.item_id);
    if (!Array.isArray(item?.acceptance) || args.acceptance_mapping.length !== item.acceptance.length ||
      args.acceptance_mapping.some((entry, index) => entry.criterion_index !== index)) {
      throw new Error('Map every canonical acceptance criterion exactly once, in order, using zero-based criterion_index.');
    }
    mapping = args.acceptance_mapping.map(entry => ({ criterion: item.acceptance[entry.criterion_index],
      implementation: entry.implementation, verification: entry.verification }));
  }
  const payload = {
    evidence_log_ids: args.evidence_log_ids, verification: args.verification,
    ...(args.decision === 'adapt_backlog' ? { implementation_instructions: args.implementation_instructions,
      equivalence_reason: args.equivalence_reason, acceptance_mapping: mapping } : {}),
    ...(args.decision === 'escalate_support' ? { impact: args.impact, requested_action: args.requested_action,
      attempted_alternatives: args.attempted_alternatives } : {}),
  };
  const { data, error } = await supabaseAdmin.rpc('record_harness_diagnostic_decision', {
    p_site_id: context.siteId, p_requirement_id: requirement.id, p_instance_id: context.instanceId,
    p_expected_backlog_revision: args.expected_backlog_revision, p_expected_updated_at: args.expected_updated_at,
    p_request_id: args.request_id, p_decision: args.decision, p_item_id: args.item_id || null,
    p_reason: args.reason, p_payload: payload,
  });
  if (error) {
    const reason = typeof error.message === 'string' && /^(?:invalid_)?harness_[a-z_]+$/.test(error.message)
      ? error.message : 'decision_storage_unavailable';
    throw new Error(`Diagnostic decision not applied (${error.code || 'storage_unavailable'}: ${reason}). Re-inspect current state and recent decisions. Never bypass execution or SQL guards.`);
  }
  const receipt = data?.decision && typeof data.decision === 'object' ? data.decision : data?.receipt || data;
  if (!receipt || !z.string().uuid().safeParse(receipt.id).success || receipt.requirement_id !== requirement.id ||
    receipt.instance_id !== context.instanceId || receipt.decision !== args.decision || receipt.request_id !== args.request_id) {
    throw new Error('Invalid diagnostic decision receipt. Do not repeat with a different request ID.');
  }
  const delivery = args.decision === 'escalate_support' ? await deliverHarnessSupportTicket(receipt, context) : undefined;
  return { success: true, decision_id: receipt.id, decision: receipt.decision, status: receipt.status,
    execution_started: false, acceptance_approved: false, ...(delivery ? { support_delivery: delivery } : {}),
    message: args.decision === 'adapt_backlog'
      ? 'Implementation strategy persisted on the existing item. Acceptance, constraints, dependencies, budgets and security holds are unchanged. The normal executor must implement and verify it.'
      : args.decision === 'approve_backlog'
        ? 'Backlog approach approved as an agent decision, not verified delivery or a worker start. Existing execution guards still apply.'
        : 'Technical support ticket persisted. Check support_delivery before claiming a message was sent. No customer product approval was requested.',
  };
}