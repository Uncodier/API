import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { LEAD_STATUSES } from '@/lib/database/lead-db';

const MAX_LEADS = 50;
const leadStatus = z.enum([...LEAD_STATUSES, 'cold', 'not_qualified']);
const leadDraft = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(254).email().optional(),
  phone: z.string().trim().min(1).max(50).optional(),
  company: z.string().trim().min(1).max(200).optional(),
  position: z.string().trim().max(200).optional(),
  notes: z.string().max(2000).optional(),
  origin: z.string().trim().max(100).optional(),
  status: leadStatus.default('new'),
}).strict().refine(lead => lead.email || lead.phone, 'Each lead requires an email or phone.');

export const leadBulkSchema = z.object({
  action: z.enum(['create', 'assign_to_me', 'change_status', 'delete']),
  leads: z.array(leadDraft).min(1).max(MAX_LEADS).optional().describe('New lead records; only for create.'),
  lead_ids: z.array(z.string().uuid().transform(id => id.toLowerCase())).min(1).max(MAX_LEADS)
    .optional().describe('Explicit, distinct lead UUIDs. Required for assign_to_me, change_status and delete.'),
  status: leadStatus.optional().describe('New status; required only for change_status.'),
  dry_run: z.boolean().default(true).describe('Preview by default. Send false to apply.'),
  preview_id: z.string().uuid().optional().describe('Required to apply. Use the exact preview_id returned for this batch; reuse it to reconcile a retry.'),
  expected_count: z.number().int().min(1).max(MAX_LEADS).optional().describe('Required to apply; use matched_count from preview.'),
  thought_process: z.string().optional(), // Added by the assistant router, not persisted.
}).strict().superRefine((input, ctx) => {
  const issue = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });
  if (input.action === 'create') {
    if (!input.leads) issue('leads', 'leads are required for create.');
    if (input.lead_ids) issue('lead_ids', 'lead_ids are not allowed for create.');
  } else {
    if (input.leads) issue('leads', 'leads are only allowed for create.');
    if (!input.lead_ids) issue('lead_ids', 'lead_ids are required for this action.');
    else if (new Set(input.lead_ids).size !== input.lead_ids.length) issue('lead_ids', 'lead_ids must be distinct.');
  }
  if (input.action === 'change_status' && !input.status) issue('status', 'status is required for change_status.');
  if (input.action !== 'change_status' && input.status) issue('status', 'status is only allowed for change_status.');
  if (input.dry_run && input.preview_id) issue('preview_id', 'preview_id is only allowed when applying.');
  if (!input.dry_run) {
    if (!input.preview_id) issue('preview_id', 'preview_id from an actual preview is required to apply.');
    if (input.expected_count === undefined) issue('expected_count', 'expected_count from preview is required to apply.');
  }
});

export type LeadBulkInput = z.infer<typeof leadBulkSchema>;
export const leadBulkParameters = zodToJsonSchema(leadBulkSchema, { $refStrategy: 'none' });