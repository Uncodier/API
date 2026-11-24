import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { LEAD_STATUSES } from '@/lib/database/lead-db';

const MAX_LEADS = 50;
const operations = z.enum(['create', 'assign_to_me', 'assign_to_member', 'change_status', 'delete']);
const jobCommands = ['job_open', 'job_select', 'job_add', 'job_seal', 'job_preview', 'job_submit', 'job_status', 'job_cancel'] as const;
const jobCount = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
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
  action: z.enum([...operations.options, ...jobCommands]),
  operation: operations.optional().describe('Operation for job_open or job_select.'),
  selection_filter: z.union([z.object({ all: z.literal(true) }).strict(), z.object({ status: leadStatus }).strict()])
    .optional().describe('For job_select: all accessible leads, or leads with this exact current status. Never infer all from an ambiguous request.'),
  job_id: z.string().uuid().optional().describe('Required for all job commands except job_open and job_select.'),
  batch_number: jobCount.optional().describe('One-based batch number for job_add or job_preview; retry an uncertain add with the same number and input.'),
  leads: z.array(leadDraft).min(1).max(MAX_LEADS).optional().describe('New lead records for create, or job_add when the job operation is create.'),
  lead_ids: z.array(z.string().uuid().transform(id => id.toLowerCase())).min(1).max(MAX_LEADS)
    .optional().describe('Explicit, distinct lead UUIDs for mutations of existing leads, including job_add.'),
  assignee_id: z.string().uuid().transform(id => id.toLowerCase()).optional()
    .describe('Site team member user UUID (not a membership record UUID); for assign_to_member or job_open with that operation.'),
  status: leadStatus.optional().describe('New status for change_status, including job_open or job_select with that operation.'),
  dry_run: z.boolean().default(true).describe('Preview by default. Send false to apply.'),
  preview_id: z.string().uuid().optional().describe('Required to apply. Use the exact preview_id returned for this batch; reuse it to reconcile a retry.'),
  expected_count: jobCount.optional().describe('Required to apply (use matched_count), or to seal and submit a job (use total_count).'),
  thought_process: z.string().optional(), // Added by the assistant router, not persisted.
}).strict().superRefine((input, ctx) => {
  const issue = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });
  if (input.action.startsWith('job_')) {
    const allowed: Record<string, string[]> = {
      job_open: ['operation', 'status', 'assignee_id'], job_add: ['job_id', 'batch_number', 'leads', 'lead_ids'],
      job_select: ['operation', 'status', 'assignee_id', 'selection_filter'], job_preview: ['job_id', 'batch_number'],
      job_seal: ['job_id', 'expected_count'], job_submit: ['job_id', 'expected_count'],
      job_status: ['job_id'], job_cancel: ['job_id'],
    };
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && !['action', 'thought_process', 'dry_run', ...allowed[input.action]].includes(key)) {
        issue(key, `Not allowed for ${input.action}.`);
      }
    }
    if (!input.dry_run) issue('dry_run', 'Use job_submit to queue a reviewed job.');
    if (input.action === 'job_open' || input.action === 'job_select') {
      if (!input.operation) issue('operation', 'operation is required.');
      if ((input.operation === 'change_status') !== (input.status !== undefined)) issue('status', 'Only change_status requires status.');
      if ((input.operation === 'assign_to_member') !== (input.assignee_id !== undefined)) issue('assignee_id', 'Only assign_to_member requires assignee_id.');
      if (input.action === 'job_select') {
        if (!input.selection_filter) issue('selection_filter', 'An explicit filter is required.');
        if (input.operation === 'create') issue('operation', 'job_select requires an operation on existing leads.');
      }
    } else if (!input.job_id) issue('job_id', 'job_id is required.');
    if (input.action === 'job_preview' && input.batch_number === undefined) issue('batch_number', 'batch_number is required.');
    if (input.action === 'job_add') {
      if (input.batch_number === undefined) issue('batch_number', 'batch_number is required.');
      if (Boolean(input.leads) === Boolean(input.lead_ids)) issue('leads', 'Provide either leads or lead_ids.');
      if (input.lead_ids && new Set(input.lead_ids).size !== input.lead_ids.length) issue('lead_ids', 'lead_ids must be distinct.');
    }
    if ((input.action === 'job_seal' || input.action === 'job_submit') && input.expected_count === undefined) {
      issue('expected_count', 'Use the exact total_count of the intended job.');
    }
    return;
  }
  for (const key of ['operation', 'job_id', 'batch_number', 'selection_filter'] as const) {
    if (input[key] !== undefined) issue(key, 'Only allowed for jobs.');
  }
  if (input.expected_count !== undefined && input.expected_count > MAX_LEADS) issue('expected_count', 'Use a job for more than 50 leads.');
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
  if (input.action === 'assign_to_member' && !input.assignee_id) issue('assignee_id', 'assignee_id is required for assign_to_member.');
  if (input.action !== 'assign_to_member' && input.assignee_id) issue('assignee_id', 'assignee_id is only allowed for assign_to_member.');
  if (input.dry_run && input.preview_id) issue('preview_id', 'preview_id is only allowed when applying.');
  if (!input.dry_run) {
    if (!input.preview_id) issue('preview_id', 'preview_id from an actual preview is required to apply.');
    if (input.expected_count === undefined) issue('expected_count', 'expected_count from preview is required to apply.');
  }
});

export type LeadBulkInput = z.infer<typeof leadBulkSchema>;
export const leadBulkParameters = zodToJsonSchema(leadBulkSchema, { $refStrategy: 'none' });