import { z } from 'zod';
import type { RequirementCommandSource } from '@/lib/services/requirement-command';
import { leadBulkParameters, leadBulkSchema } from './schema';

const hostSchema = z.object({
  siteId: z.string().uuid(), userId: z.string().uuid(), instanceId: z.string().uuid(), actionId: z.string().uuid(),
}).strict();

export function leadBulkOperationsTool(host: RequirementCommandSource) {
  const scope = hostSchema.safeParse(host);
  return {
    name: 'leads_bulk_operations',
    description: [
      'Bulk CRM lead operations: create, assign, change status, or delete. Up to 50 leads per request; durable jobs accept multiple batches.',
      'For existing leads, use leads(list) to resolve the exact UUIDs; never guess, infer all leads from a partial page, or silently narrow a requested selection.',
      'For assign_to_member, resolve the teammate in the current site with calendars(list, query), and use team_members[].user_id as assignee_id. If there is no unambiguous match, ask the user. Do not guess an ID.',
      'Preview first (dry_run=true, the default). Apply the exact same batch with dry_run=false, preview_id from the preview, and expected_count from matched_count. Resolve missing IDs before applying.',
      'Delete permanently removes leads and may remove linked records. Only owners/admins can delete. Show the preview to the user and ask them to send its exact confirmation_message as a new chat message before applying. Do not confirm on their behalf.',
      'Report actual affected_count. If a write result is unknown, replay only the same preview_id and parameters to recover its receipt; never start a new preview to retry that write. Use sendBulkMessages for messaging, not this tool.',
      'For more than 50 leads, use job_open with operation and any required status or assignee_id. Send job_add with job_id, batch_number starting at 1, and up to 50 exact IDs or create drafts per call. Add all requested leads before sealing; never silently truncate or replace a missing selection.',
      'If the user explicitly requests all accessible leads or an exact current status, use job_select with operation and selection_filter {all:true} or {status:...}, instead of enumerating IDs. The cron prepares the manifest. Poll job_status; selecting is not ready. Do not substitute a wider filter or submit automatically from a partial count.',
      'Seal using job_seal with job_id and expected_count equal to the intended total. For delete, show the job preview and require its exact confirmation_message in a new user chat message. Then use job_submit with the same job_id and expected_count. Queued does not mean applied.',
      'Use job_status with job_id for progress. Batches commit in sequence; a permanent error stops later batches without rolling back completed batches. job_cancel stops remaining batches, not completed work. Retry uncertain job commands with identical arguments; never create a replacement job to retry.',
      'After sealing, job_preview returns the exact selection by batch_number (start at 1, follow next_batch_number). For delete, show the first page and offer the remaining pages before requesting confirmation. If a reviewed page contains a changed or unavailable lead, do not submit; report the stale selection and ask to prepare a new one. A count alone is not a reviewed list.',
    ].join('\n'),
    parameters: leadBulkParameters,
    execute: async (args: unknown) => {
      if (!scope.success) return { success: false, executed: false, error: 'A verified interactive assistant action is required.' };
      const input = leadBulkSchema.safeParse(args);
      if (!input.success) return { success: false, executed: false, error: 'Invalid lead bulk operation parameters.',
        issues: input.error.issues.map(({ path, message }) => ({ path, message })) };
      if (input.data.action.startsWith('job_')) {
        const { executeLeadBulkJob } = await import('./jobs');
        return executeLeadBulkJob(scope.data, input.data);
      }
      const { executeLeadBulkOperation } = await import('./core');
      return executeLeadBulkOperation(scope.data, input.data);
    },
  };
}