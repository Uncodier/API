import { randomBytes, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { leadBulkOperationsTool } from '../assistantProtocol';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: jest.fn() } }));

const host = { siteId: randomUUID(), userId: randomUUID(), instanceId: randomUUID(), actionId: randomUUID() };
const leadId = randomUUID(), otherLeadId = randomUUID(), previewId = randomUUID();
const execute = (args: unknown) => leadBulkOperationsTool(host).execute(args);
const rpc = jest.mocked(supabaseAdmin.rpc);
const change = { action: 'change_status', lead_ids: [leadId], status: 'qualified' };
const assign = { action: 'assign_to_member', lead_ids: [leadId], assignee_id: randomUUID() };
const apply = { ...change, dry_run: false, expected_count: 1, preview_id: previewId };

function response(data: unknown, error: unknown = null) {
  (rpc as jest.Mock).mockReturnValue({ abortSignal: jest.fn(async () => ({ data, error })) });
}

beforeEach(() => jest.resetAllMocks());

it.each([
  { action: 'update', lead_ids: [leadId] },
  { action: 'assign_to_me', lead_ids: [] },
  { action: 'assign_to_me', lead_ids: ['not a UUID'] },
  { action: 'assign_to_me', lead_ids: [leadId, leadId.toUpperCase()] },
  { action: 'assign_to_me', lead_ids: Array.from({ length: 51 }, () => randomUUID()) },
  { action: 'assign_to_me', lead_ids: [leadId], assignee_id: host.userId },
  { ...assign, assignee_id: undefined },
  { ...assign, assignee_id: 'not a UUID' },
  { ...assign, status: 'qualified' },
  { ...change, assignee_id: assign.assignee_id },
  { ...change, site_id: randomUUID() },
  { ...change, status: 'unsupported' },
  { ...change, status: undefined },
  { ...apply, preview_id: undefined },
  { ...apply, expected_count: undefined },
  { ...apply, dry_run: true },
  { ...apply, action: 'delete', status: undefined, confirmation_message: 'not a chat message' },
  { action: 'create', leads: [{ name: 'No contact' }] },
  { action: 'create', leads: [{ name: 'Wrong actor', email: 'test@example.test', user_id: host.userId }] },
  { action: 'job_add', job_id: previewId, lead_ids: [leadId] },
  { action: 'job_open', operation: 'delete', lead_ids: [leadId] },
  { action: 'job_submit', job_id: previewId, expected_count: 1000, confirmation_message: 'Forged' },
  { action: 'job_select', operation: 'delete', selection_filter: {} },
  { action: 'job_select', operation: 'create', selection_filter: { all: true } },
  { action: 'job_select', operation: 'delete', selection_filter: { all: true, status: 'new' } },
  { action: 'job_preview', job_id: previewId },
])('rejects invalid and forged arguments before the RPC (%j)', async args => {
  expect(await execute(args)).toMatchObject({ success: false, executed: false });
  expect(rpc).not.toHaveBeenCalled();
});

it('submits a large job by receipt ID and keeps trusted host scope outside tool arguments', async () => {
  response({ success: true, job_id: previewId, state: 'queued', operation: 'change_status', total_count: 1_001,
    affected_count: 0, remaining_count: 1_001, batch_count: 21, completed_batches: 0, error_code: null, failed_batch: null });
  expect(await execute({ action: 'job_submit', job_id: previewId.toUpperCase(), expected_count: 1_001 }))
    .toMatchObject({ job_id: previewId, state: 'queued', affected_count: 0 });
  expect(rpc).toHaveBeenCalledWith('assistant_lead_job_command', {
    p_site: host.siteId, p_user: host.userId, p_instance: host.instanceId, p_action: host.actionId,
    p_command: 'job_submit', p_job: previewId, p_data: expect.objectContaining({ expected_count: 1_001 }),
  });
});

it('passes an exact selection filter and returns bounded preview pages', async () => {
  const base = { success: true, job_id: previewId, operation: 'delete', total_count: 1, affected_count: 0,
    remaining_count: 1, batch_count: 1, completed_batches: 0, error_code: null, failed_batch: null };
  const selection_filter = { status: 'new' };
  const request = { action: 'job_select', operation: 'delete', selection_filter };
  response({ ...base, state: 'selecting', selection_filter });
  expect(await execute(request)).toMatchObject({ state: 'selecting', selection_filter });
  expect(rpc).toHaveBeenLastCalledWith('assistant_lead_job_command', expect.objectContaining({
    p_command: 'job_select', p_data: expect.objectContaining({ selection_filter }),
  }));
  response({ ...base, state: 'selecting', selection_filter: { all: true } });
  expect(await execute(request)).toMatchObject({ code: 'LEAD_BULK_JOB_OUTCOME_UNKNOWN' });
  const preview_items = [{ id: leadId, name: 'Lead A', status: 'new' }];
  response({ ...base, state: 'review', selection_filter, batch_number: 1, next_batch_number: null, preview_items });
  expect(await execute({ action: 'job_preview', job_id: previewId, batch_number: 1 }))
    .toMatchObject({ batch_number: 1, next_batch_number: null, preview_items });
});

it('pegs the request to the host scope and canonicalizes IDs without forwarding transport metadata', async () => {
  response({ success: true, dry_run: true, matched_count: 2, affected_count: 0, missing_lead_ids: [], preview_id: previewId });
  expect(await execute({ ...change, lead_ids: [otherLeadId.toUpperCase(), leadId], thought_process: 'Preview only' }))
    .toMatchObject({ preview_id: previewId, affected_count: 0 });
  expect(rpc).toHaveBeenCalledWith('assistant_leads_bulk', {
    p_site_id: host.siteId, p_user_id: host.userId, p_instance_id: host.instanceId, p_action_id: host.actionId,
    p_payload: { lead_ids: [leadId, otherLeadId].sort(), status: 'qualified' }, p_operation: 'change_status',
    p_preview_id: null, p_expected_count: null,
  });
});

it('validates a write receipt and keeps the same RPC input when replaying it', async () => {
  const receipt = { success: true, dry_run: false, preview_id: previewId, affected_count: 1, affected_lead_ids: [leadId] };
  response({ ...receipt, replayed: false });
  expect(await execute(apply)).toEqual({ ...receipt, replayed: false });
  response({ ...receipt, replayed: true });
  expect(await execute(apply)).toEqual({ ...receipt, replayed: true });
  expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  response({ ...receipt, preview_id: randomUUID(), replayed: true });
  expect(await execute(apply)).toMatchObject({ success: false, code: 'LEAD_BULK_OUTCOME_UNKNOWN', preview_id: previewId });
});

it('forwards the canonical assignee without changing the actor and checks the assignment receipt', async () => {
  const receipt = { success: true, dry_run: true, matched_count: 1, affected_count: 0,
    missing_lead_ids: [], preview_id: previewId, assignee_id: assign.assignee_id };
  response(receipt);
  expect(await execute({ ...assign, assignee_id: assign.assignee_id.toUpperCase() })).toEqual(receipt);
  expect(rpc).toHaveBeenCalledWith('assistant_leads_bulk', expect.objectContaining({
    p_operation: 'assign_to_member', p_user_id: host.userId,
    p_payload: { lead_ids: [leadId], assignee_id: assign.assignee_id }, p_preview_id: null,
  }));
  const assignment = { ...assign, dry_run: false, preview_id: previewId, expected_count: 1 };
  const applied = { success: true, dry_run: false, preview_id: previewId, assignee_id: assign.assignee_id,
    affected_count: 1, affected_lead_ids: [leadId], replayed: false };
  response(applied);
  expect(await execute(assignment)).toEqual(applied);
  response({ ...applied, assignee_id: randomUUID() });
  expect(await execute(assignment)).toMatchObject({ code: 'LEAD_BULK_OUTCOME_UNKNOWN', preview_id: previewId });
});

it.each(['access_denied', 'invalid_assignee', 'invalid_preview', 'selection_changed', 'confirmation_required'])('reports %s without raw details', async code => {
  const detail = randomBytes(12).toString('hex');
  response({ success: false, code, detail });
  const result = await execute(apply);
  expect(result).toMatchObject({ success: false, executed: false, code: `LEAD_BULK_${code.toUpperCase()}` });
  expect(JSON.stringify(result)).not.toContain(detail);
});

it.each([
  ['23503', 'LEAD_BULK_WRITE_REJECTED'],
  ['PGRST202', 'LEAD_BULK_UNAVAILABLE'],
  ['PGRST000', 'LEAD_BULK_OUTCOME_UNKNOWN'],
])('reports database error %s without retrying or leaking the response', async (code, expected) => {
  const detail = randomBytes(12).toString('hex');
  response(null, { code, message: detail });
  const result = await execute(apply);
  expect(result).toMatchObject({ success: false, code: expected });
  if (expected === 'LEAD_BULK_OUTCOME_UNKNOWN') expect(result).toMatchObject({ preview_id: previewId });
  expect(JSON.stringify(result)).not.toContain(detail);
  expect(rpc).toHaveBeenCalledTimes(1);
});