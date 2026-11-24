import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { RequirementCommandSource } from '@/lib/services/requirement-command';
import type { LeadBulkInput } from './schema';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const receipt = z.object({
  success: z.literal(true), job_id: z.string().uuid(), state: z.enum(['selecting', 'draft', 'review', 'queued', 'completed', 'failed', 'cancelled', 'expired']),
  operation: z.enum(['create', 'assign_to_me', 'assign_to_member', 'change_status', 'delete']),
  total_count: count, affected_count: count, remaining_count: count, batch_count: count, completed_batches: count,
  error_code: z.string().nullable(), failed_batch: count.nullable(),
  status: z.string().optional(), assignee_id: z.string().uuid().optional(), expires_at: z.string().optional(),
  confirmation_message: z.string().optional(), batch_number: count.optional(), added_count: count.optional(), replayed: z.boolean().optional(),
  selection_filter: z.union([z.object({ all: z.literal(true) }), z.object({ status: z.string() })]).optional(),
  next_batch_number: count.nullable().optional(),
  preview_items: z.array(z.union([
    z.object({ unavailable: z.literal(true) }).strict(),
    z.object({ id: z.string().uuid(), changed: z.literal(true) }).strict(),
    z.object({ id: z.string().uuid().optional(), name: z.string().nullable(), status: z.string().nullable() }).strict(),
  ])).max(50).optional(),
});
const rejection = z.object({
  success: z.literal(false), code: z.enum(['access_denied', 'invalid_job_state', 'invalid_assignee', 'confirmation_required', 'missing_leads', 'duplicate_leads']),
  missing_lead_ids: z.array(z.string().uuid()).max(50).optional(), duplicate_lead_ids: z.array(z.string().uuid()).max(50).optional(),
});
const messages: Record<z.infer<typeof rejection>['code'], string> = {
  access_denied: 'This job is not available to this session or user.',
  invalid_job_state: 'Check the job state, next batch number, expiration, and expected total before retrying.',
  invalid_assignee: 'Choose a team member with active access to this site.',
  confirmation_required: 'The user must send the exact confirmation from the reviewed job in the same chat.',
  missing_leads: 'The batch was not added. Some leads are missing or unavailable. Resolve the selection before continuing.',
  duplicate_leads: 'The batch was not added. Some lead IDs are already in this job.',
};

export async function executeLeadBulkJob(host: RequirementCommandSource, input: LeadBulkInput) {
  const jobId = input.job_id?.toLowerCase();
  const unavailable = () => ({ success: false, code: 'LEAD_BULK_JOB_OUTCOME_UNKNOWN', ...(jobId && { job_id: jobId }),
    error: 'Job response could not be verified. Retry the exact command or check job_status; do not start a replacement job.' });
  const { data, error } = await (async () => {
    try {
      return await supabaseAdmin.rpc('assistant_lead_job_command', {
        p_site: host.siteId, p_user: host.userId, p_instance: host.instanceId, p_action: host.actionId,
        p_command: input.action, p_job: jobId ?? null,
        p_data: {
          operation: input.operation, status: input.status, assignee_id: input.assignee_id,
          batch_number: input.batch_number, leads: input.leads, lead_ids: input.lead_ids, expected_count: input.expected_count,
          selection_filter: input.selection_filter,
        },
      }).abortSignal(AbortSignal.timeout(15_000));
    } catch {
      return { data: null, error: null };
    }
  })();
  if (error && ['PGRST202', '42883'].includes(error.code)) {
    return { success: false, executed: false, code: 'LEAD_BULK_JOB_UNAVAILABLE', error: 'Lead bulk jobs are unavailable. Check the database migration.' };
  }
  const refused = rejection.safeParse(data);
  if (refused.success) return { ...refused.data, executed: false, error: messages[refused.data.code] };
  const parsed = receipt.safeParse(data);
  if (!parsed.success || (jobId && parsed.data.job_id !== jobId) || (input.operation && parsed.data.operation !== input.operation)) return unavailable();
  if (input.action === 'job_select') {
    const requested = input.selection_filter, returned = parsed.data.selection_filter;
    if (!requested || !returned || ('all' in requested ? !('all' in returned)
      : !('status' in returned) || returned.status !== requested.status)) return unavailable();
  }
  if (input.action === 'job_preview' && (parsed.data.batch_number !== input.batch_number || !parsed.data.preview_items)) return unavailable();
  return parsed.data;
}