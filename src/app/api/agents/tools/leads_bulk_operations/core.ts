import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { RequirementCommandSource } from '@/lib/services/requirement-command';
import type { LeadBulkInput } from './schema';

const uuid = z.string().uuid();
const previewReceipt = z.object({ success: z.literal(true), dry_run: z.literal(true), matched_count: z.number().int(),
  affected_count: z.literal(0), missing_lead_ids: z.array(uuid), preview_id: uuid.optional() }).passthrough();
const executionReceipt = z.object({ success: z.literal(true), dry_run: z.literal(false), preview_id: uuid,
  affected_count: z.number().int(), affected_lead_ids: z.array(uuid), replayed: z.boolean() }).passthrough();

const rejected = {
  access_denied: 'Lead bulk operation is not permitted for this user or session.',
  invalid_preview: 'Preview not found, expired, or does not match this exact batch. If a previous write outcome is unknown, reconcile before starting a new preview.',
  selection_changed: 'No changes applied. The selected leads or their revisions changed. Preview and review again.',
  confirmation_required: 'Ask the user to review the preview and send its exact confirmation message in the same chat.',
} as const;

function noWrite(code: string, error: string) {
  return { success: false, executed: false, code, error };
}

export async function executeLeadBulkOperation(host: RequirementCommandSource, input: LeadBulkInput) {
  const previewId = input.preview_id?.toLowerCase();
  const { action, dry_run } = input;
  const payload = action === 'create' ? { leads: input.leads }
    : { lead_ids: [...(input.lead_ids ?? [])].sort(), ...(action === 'change_status' ? { status: input.status } : {}) };
  const unavailable = () => dry_run
    ? noWrite('LEAD_BULK_UNAVAILABLE', 'The preview is unavailable. No lead write was requested.')
    : { success: false, code: 'LEAD_BULK_OUTCOME_UNKNOWN', preview_id: previewId,
      error: 'Could not verify the outcome. Use only the same preview_id and parameters to recover the receipt; do not start a new batch.' };

  try {
    const { data, error } = await supabaseAdmin.rpc('assistant_leads_bulk', {
      p_site_id: host.siteId, p_user_id: host.userId, p_instance_id: host.instanceId, p_action_id: host.actionId,
      p_operation: action, p_payload: payload, p_preview_id: previewId ?? null, p_expected_count: input.expected_count ?? null,
    }).abortSignal(AbortSignal.timeout(15_000));
    if (error) {
      if (error.code === '42501') return noWrite('LEAD_BULK_ACCESS_DENIED', rejected.access_denied);
      if (['PGRST202', '42883'].includes(error.code)) return noWrite('LEAD_BULK_UNAVAILABLE', 'Lead bulk operations are unavailable. Check that the database migration is deployed.');
      if (/^(22|23)\d{3}$/.test(error.code)) return noWrite('LEAD_BULK_WRITE_REJECTED', error.code === '23503'
        ? 'Linked records prevented the entire batch from being applied.' : error.code === '23505'
          ? 'A conflicting lead prevented the entire batch from being applied.' : 'The database rejected the entire batch.');
      return unavailable();
    }
    if (data?.success === false && typeof data.code === 'string' && Object.hasOwn(rejected, data.code)) {
      return noWrite(`LEAD_BULK_${data.code.toUpperCase()}`, rejected[data.code as keyof typeof rejected]);
    }
    if (dry_run) {
      const receipt = previewReceipt.safeParse(data);
      return receipt.success ? receipt.data : unavailable();
    }
    const receipt = executionReceipt.safeParse(data);
    return receipt.success && receipt.data.preview_id === previewId && receipt.data.affected_count === input.expected_count
      && new Set(receipt.data.affected_lead_ids).size === receipt.data.affected_count ? receipt.data : unavailable();
  } catch {
    return unavailable();
  }
}