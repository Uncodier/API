import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { canReadProcurementWorkflowInstanceAsActor, filterAccessibleProcurementWorkflowInstances } from '@/lib/services/workflow-robot/procurement-access';
import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';
import { getInstancePlansCore, InstancePlansReadForbiddenError } from '../core';
import { POST } from '../route';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/workflow-robot/procurement-access', () => ({
  canReadProcurementWorkflowInstanceAsActor: jest.fn(),
  filterAccessibleProcurementWorkflowInstances: jest.fn(),
}));
jest.mock('@/lib/security/tool-request-principal', () => ({
  resolveToolRequestPrincipal: jest.fn(), canToolPrincipalAccessSite: jest.fn(),
}));

const siteId = randomUUID();
const instanceId = randomUUID();
const userId = randomUUID();
const privilegedUserId = randomUUID();

function query(result: Record<string, unknown>) {
  const builder: Record<string, jest.Mock> = {};
  for (const name of ['select', 'eq', 'in', 'order']) builder[name] = jest.fn(() => builder);
  builder.range = jest.fn(async () => result);
  return builder;
}

beforeEach(() => jest.resetAllMocks());

it('denies an instance payload before querying, ignoring a filter-supplied privileged actor', async () => {
  (canReadProcurementWorkflowInstanceAsActor as jest.Mock).mockResolvedValue(false);
  await expect(getInstancePlansCore({ site_id: siteId, instance_id: instanceId, user_id: privilegedUserId },
    { userId, internal: false })).rejects.toBeInstanceOf(InstancePlansReadForbiddenError);
  expect(canReadProcurementWorkflowInstanceAsActor).toHaveBeenCalledWith(siteId, instanceId, userId);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('missing trusted scope never promotes filters.user_id into the authorization actor', async () => {
  (canReadProcurementWorkflowInstanceAsActor as jest.Mock).mockResolvedValue(false);
  await expect(getInstancePlansCore({ site_id: siteId, instance_id: instanceId, user_id: privilegedUserId }))
    .rejects.toBeInstanceOf(InstancePlansReadForbiddenError);
  expect(canReadProcurementWorkflowInstanceAsActor).toHaveBeenCalledWith(siteId, instanceId, null);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('allows an authorized actor and retains ordinary plan pagination', async () => {
  (canReadProcurementWorkflowInstanceAsActor as jest.Mock).mockResolvedValue(true);
  const plans = query({ data: [{ id: randomUUID(), instance_id: instanceId }], error: null, count: 1 });
  (supabaseAdmin.from as jest.Mock).mockReturnValue(plans);
  const result = await getInstancePlansCore({ site_id: siteId, instance_id: instanceId }, { userId, internal: false });
  expect(result.data.plans).toHaveLength(1);
  expect(result.data.pagination.total).toBe(1);
});

it('applies accessible instance IDs before plans counts and pagination', async () => {
  const deniedId = randomUUID();
  const candidates = query({ data: [{ id: instanceId }, { id: deniedId }], error: null });
  const plans = query({ data: [{ id: randomUUID(), instance_id: instanceId }], count: 1, error: null });
  (supabaseAdmin.from as jest.Mock).mockImplementation(table => table === 'remote_instances' ? candidates : plans);
  (filterAccessibleProcurementWorkflowInstances as jest.Mock).mockResolvedValue(new Set([instanceId]));
  const result = await getInstancePlansCore({ site_id: siteId }, { userId, internal: false });
  expect(filterAccessibleProcurementWorkflowInstances).toHaveBeenCalledWith(siteId, userId, [instanceId, deniedId]);
  expect(plans.in).toHaveBeenCalledWith('instance_id', [instanceId]);
  expect(plans.in.mock.invocationCallOrder[0]).toBeLessThan(plans.range.mock.invocationCallOrder[0]);
  expect(result.data.pagination).toMatchObject({ total: 1, count: 1, has_more: false });
});

it('does not query plans or expose denied counts for a fully inaccessible list', async () => {
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query({ data: [{ id: instanceId }], error: null }));
  (filterAccessibleProcurementWorkflowInstances as jest.Mock).mockResolvedValue(new Set());
  const result = await getInstancePlansCore({ site_id: siteId }, { userId, internal: false });
  expect(supabaseAdmin.from).toHaveBeenCalledTimes(1);
  expect(result.data.plans).toEqual([]);
  expect(result.data.pagination.total).toBe(0);
});

it('route uses verified principal, not a privileged body user_id', async () => {
  (resolveToolRequestPrincipal as jest.Mock).mockResolvedValue({ userId, internal: false, siteId });
  (canToolPrincipalAccessSite as jest.Mock).mockResolvedValue(true);
  (canReadProcurementWorkflowInstanceAsActor as jest.Mock).mockResolvedValue(false);
  const response = await POST(new NextRequest('https://api.example.test/instance-plans', {
    method: 'POST', body: JSON.stringify({ site_id: siteId, instance_id: instanceId, user_id: privilegedUserId }),
  }));
  expect(response.status).toBe(403);
  expect(canReadProcurementWorkflowInstanceAsActor).toHaveBeenCalledWith(siteId, instanceId, userId);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('route rejects unauthenticated callers before reading plans', async () => {
  (resolveToolRequestPrincipal as jest.Mock).mockResolvedValue(null);
  const response = await POST(new NextRequest('https://api.example.test/instance-plans', {
    method: 'POST', body: JSON.stringify({ site_id: siteId, instance_id: instanceId }),
  }));
  expect(response.status).toBe(401);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});