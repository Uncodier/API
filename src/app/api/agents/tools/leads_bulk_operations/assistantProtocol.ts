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
      'Bulk CRM lead operations: create leads, assign selected leads to the current user or a teammate, change their status, or delete them. Up to 50 per call.',
      'For existing leads, use leads(list) to resolve the exact UUIDs; never guess, infer all leads from a partial page, or silently narrow a requested selection.',
      'For assign_to_member, resolve the teammate in the current site with calendars(list, query), and use team_members[].user_id as assignee_id. If there is no unambiguous match, ask the user. Do not guess an ID.',
      'Preview first (dry_run=true, the default). Apply the exact same batch with dry_run=false, preview_id from the preview, and expected_count from matched_count. Resolve missing IDs before applying.',
      'Delete permanently removes leads and may remove linked records. Only owners/admins can delete. Show the preview to the user and ask them to send its exact confirmation_message as a new chat message before applying. Do not confirm on their behalf.',
      'Report actual affected_count. If a write result is unknown, replay only the same preview_id and parameters to recover its receipt; never start a new preview to retry that write. Use sendBulkMessages for messaging, not this tool.',
    ].join('\n'),
    parameters: leadBulkParameters,
    execute: async (args: unknown) => {
      if (!scope.success) return { success: false, executed: false, error: 'A verified interactive assistant action is required.' };
      const input = leadBulkSchema.safeParse(args);
      if (!input.success) return { success: false, executed: false, error: 'Invalid lead bulk operation parameters.',
        issues: input.error.issues.map(({ path, message }) => ({ path, message })) };
      const { executeLeadBulkOperation } = await import('./core');
      return executeLeadBulkOperation(scope.data, input.data);
    },
  };
}