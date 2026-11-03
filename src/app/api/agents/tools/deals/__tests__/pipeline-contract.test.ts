import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { fireWorkflowDispatch } from '@/lib/services/workflow-robot/dispatch';
import { fetchApiTool, ToolApiError } from '../../utils/fetch-helper';
import { getDealsCore } from '../get/core';
import { POST as create } from '../create/route';
import { POST as update } from '../update/route';
import { dealsTool } from '../assistantProtocol';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/services/workflow-robot/dispatch', () => ({ fireWorkflowDispatch: jest.fn() }));
jest.mock('../get/core', () => ({ getDealsCore: jest.fn() }));

// Independent CRM identifiers: do not derive expectations from the implementation.
const stages = ['prospecting', 'qualification', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];
const statuses = ['open', 'won', 'lost'];
const siteId = randomUUID();
const dealId = randomUUID();
const ownerId = randomUUID();
const leadId = randomUUID();
const request = (body: unknown) => new NextRequest('https://api.example.invalid/deals', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
});
let stored: Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  stored = { id: dealId, site_id: siteId, name: 'Test opportunity', stage: 'proposal', status: 'open' };
  (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
    const query: any = {
      insert: jest.fn((rows: Record<string, unknown>[]) => { stored = { id: dealId, ...rows[0] }; return query; }),
      update: jest.fn((fields: Record<string, unknown>) => { stored = { ...stored, ...fields }; return query; }),
      select: jest.fn(() => query),
      eq: jest.fn(() => query),
      single: jest.fn(async () => ({ data: stored, error: null })),
      then: (resolve: (result: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
    };
    return query;
  });
});
afterEach(() => jest.restoreAllMocks());

it('advertises exactly the CRM stage and status options and the Qualified mapping', () => {
  const tool = dealsTool(siteId);
  expect(tool.parameters.properties.stage.enum).toEqual(stages);
  expect(tool.parameters.properties.status.enum).toEqual(statuses);
  expect(tool.parameters.properties.stage.description).toContain('not qualified');
  expect(tool.description).toContain('retry');
});

describe.each([['create', create], ['update', update]] as const)('%s route', (_action, handler) => {
  it.each([
    { stage: 'qualified' }, { stage: 'Qualified' }, { stage: 'custom_stage' },
    { stage: '' }, { stage: null }, { status: 'closed_won' }, { status: 'custom_status' },
  ])('fails safely with actionable feedback for %j', async invalid => {
    const response = await handler(request({ site_id: siteId, deal_id: dealId, name: 'Test',
      owner_ids: [ownerId], lead_ids: [leadId], ...invalid }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false, code: 'INVALID_DEAL_DATA', changes_made: false,
      allowed_values: { stage: stages, status: statuses },
      error: expect.stringContaining('stage="qualification", not "qualified"'),
      details: expect.arrayContaining([expect.objectContaining({ path: [Object.keys(invalid)[0]] })]),
    });
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
    expect(fireWorkflowDispatch).not.toHaveBeenCalled();
  });

  it.each(stages)('accepts and preserves canonical stage %s', async stage => {
    const response = await handler(request({ site_id: siteId, deal_id: dealId, name: 'Test', stage }));
    expect(response.status).toBe(_action === 'create' ? 201 : 200);
    expect((await response.json()).deal.stage).toBe(stage);
  });

  it.each(statuses)('accepts and preserves status %s', async status => {
    const response = await handler(request({ site_id: siteId, deal_id: dealId, name: 'Test', status }));
    expect((await response.json()).deal.status).toBe(status);
  });
});

it('keeps creation defaults and does not overwrite an omitted update stage/status', async () => {
  const created = await create(request({ site_id: siteId, name: 'Test' }));
  expect((await created.json()).deal).toMatchObject({ stage: 'prospecting', status: 'open' });
  stored = { ...stored, stage: 'negotiation', status: 'won' };
  const updated = await update(request({ site_id: siteId, deal_id: dealId, notes: 'New note' }));
  expect((await updated.json()).deal).toMatchObject({ stage: 'negotiation', status: 'won', notes: 'New note' });
});

it.each(['create', 'update', 'list'] as const)('rejects invalid %s tool arguments before HTTP or database access', async action => {
  const fetch = jest.spyOn(globalThis, 'fetch');
  await expect(dealsTool(siteId).execute({ action, name: 'Test', deal_id: dealId, stage: 'qualified' }))
    .rejects.toMatchObject({ name: 'ToolApiError', status: 400,
      message: expect.stringContaining('qualification'), result: { success: false, changes_made: false } });
  expect(fetch).not.toHaveBeenCalled();
  expect(getDealsCore).not.toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('lets the tool retry with qualification and preserves the owner and site', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    success: true, deal: { id: dealId, stage: 'qualification' },
  }), { status: 201 }));
  const result = await dealsTool(siteId).execute({ action: 'create', name: 'Test',
    stage: 'qualification', status: 'open', owner_ids: ownerId });
  expect(result.success).toBe(true);
  expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toMatchObject({
    site_id: siteId, stage: 'qualification', status: 'open', owner_ids: [ownerId],
  });
});

it('preserves route validation feedback through the real HTTP helper', async () => {
  const response = await create(request({ site_id: siteId, name: 'Test', stage: 'qualified' }));
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  try {
    await fetchApiTool('/api/agents/tools/deals/create', {}, 'Deal creation failed');
    throw new Error('Expected validation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(ToolApiError);
    expect(error).toMatchObject({ status: 400, message: expect.stringContaining('correct the arguments and retry'),
      result: { allowed_values: { stage: stages, status: statuses }, changes_made: false } });
  }
});