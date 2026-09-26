// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const from = jest.fn();
let runSiteId = '';
let channelRows: any[] = [];
let graphTriggerNodes: any[] = [];
const hasAuthenticatedPrincipal = jest.fn();
const isInternalServiceRequest = jest.fn();
const canAccessSite = jest.fn();
const getRequestSitePrincipal = jest.fn();
const isSiteSkillManager = jest.fn();
const syncWorkflowDefinition = jest.fn();
const materializeRunFromGraph = jest.fn();
const runWorkflowPlan = jest.fn();

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({
  hasAuthenticatedPrincipal, isInternalServiceRequest,
}));
jest.unstable_mockModule('@/lib/security/site-access', () => ({ canAccessSite, getRequestSitePrincipal }));
jest.unstable_mockModule('@/lib/services/site-skill-access', () => ({ isSiteSkillManager }));
jest.unstable_mockModule('../materialize', () => ({ syncWorkflowDefinition, materializeRunFromGraph }));
jest.unstable_mockModule('../run-plan', () => ({ runWorkflowPlan }));

const { POST: sync } = await import('@/app/api/workflows/[instanceId]/sync-triggers/route');
const { POST: run } = await import('@/app/api/workflows/[instanceId]/run/route');
const { POST: resume } = await import('@/app/api/workflows/runs/[runPlanId]/run/route');

const instanceId = '11111111-1111-4111-8111-111111111111';
const siteId = '22222222-2222-4222-8222-222222222222';
const request = () => new NextRequest(`https://api.example/api/workflows/${instanceId}/run`, {
  method: 'POST', body: JSON.stringify({ payload: {} }),
});
const context = (id = instanceId) => ({ params: Promise.resolve({ instanceId: id }) });

beforeEach(() => {
  jest.clearAllMocks();
  runSiteId = siteId;
  channelRows = [];
  graphTriggerNodes = [];
  hasAuthenticatedPrincipal.mockReturnValue(true);
  isInternalServiceRequest.mockReturnValue(false);
  canAccessSite.mockResolvedValue(true);
  getRequestSitePrincipal.mockReturnValue({ userId: 'manager-1' });
  isSiteSkillManager.mockResolvedValue(true);
  from.mockImplementation((table: string) => {
    if (!['remote_instances', 'workflow_runs', 'workflow_triggers', 'instance_nodes'].includes(table)) {
      throw new Error('Unexpected table');
    }
    const query: any = {};
    query.select = jest.fn().mockReturnValue(query);
    query.eq = jest.fn().mockReturnValue(query);
    query.maybeSingle = jest.fn().mockResolvedValue({ data: table === 'remote_instances'
      ? { site_id: siteId }
      : { site_id: runSiteId, instance_id: instanceId }, error: null });
    query.limit = jest.fn().mockResolvedValue({ data: channelRows, error: null });
    if (table === 'instance_nodes') query.then = (resolve: (value: any) => any) =>
      Promise.resolve({ data: graphTriggerNodes, error: null }).then(resolve);
    return query;
  });
  syncWorkflowDefinition.mockResolvedValue({ template_plan_id: 'template-1' });
  materializeRunFromGraph.mockResolvedValue({ run_plan_id: 'run-1' });
  runWorkflowPlan.mockResolvedValue({ status: 'completed' });
});

it('does not turn channel_message into a full-tool LIVE run, even before trigger sync', async () => {
  channelRows = [{ id: 'channel-row' }];
  expect((await run(request(), context())).status).toBe(400);
  channelRows = [];
  graphTriggerNodes = [{ settings: { trigger: { active_kinds: ['channel_message'] } } }];
  expect((await run(request(), context())).status).toBe(400);
  expect(materializeRunFromGraph).not.toHaveBeenCalled();
});

describe('run-plan resume route', () => {
  const runPlanId = '33333333-3333-4333-8333-333333333333';
  const runContext = { params: Promise.resolve({ runPlanId }) };

  it('rejects unauthenticated, invalid, cross-tenant, and non-manager callers', async () => {
    hasAuthenticatedPrincipal.mockReturnValueOnce(false);
    expect((await resume(request(), runContext)).status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect((await resume(request(), { params: Promise.resolve({ runPlanId: 'bad' }) })).status).toBe(400);
    runSiteId = 'unrelated-site';
    expect((await resume(request(), runContext)).status).toBe(403);
    runSiteId = siteId;
    canAccessSite.mockResolvedValueOnce(false);
    expect((await resume(request(), runContext)).status).toBe(403);
    isSiteSkillManager.mockResolvedValueOnce(false);
    expect((await resume(request(), runContext)).status).toBe(403);
    expect(runWorkflowPlan).not.toHaveBeenCalled();
  });

  it('executes only a canonical-site authorized run', async () => {
    expect((await resume(request(), runContext)).status).toBe(200);
    expect(runWorkflowPlan).toHaveBeenCalledWith(runPlanId);
  });
});

describe.each([['sync', sync], ['run', run]])('%s workflow write route', (_name, post) => {
  it('rejects unauthenticated and malformed instance requests before any service-role read', async () => {
    hasAuthenticatedPrincipal.mockReturnValue(false);
    expect((await post(request(), context())).status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    hasAuthenticatedPrincipal.mockReturnValue(true);
    expect((await post(request(), context('not-an-instance'))).status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant callers and non-manager site members before writes', async () => {
    canAccessSite.mockResolvedValueOnce(false);
    expect((await post(request(), context())).status).toBe(403);
    expect(isSiteSkillManager).not.toHaveBeenCalled();
    isSiteSkillManager.mockResolvedValueOnce(false);
    expect((await post(request(), context())).status).toBe(403);
    expect(syncWorkflowDefinition).not.toHaveBeenCalled();
    expect(materializeRunFromGraph).not.toHaveBeenCalled();
  });

  it('allows a site manager or an authenticated internal service only', async () => {
    expect((await post(request(), context())).status).toBe(200);
    expect(canAccessSite).toHaveBeenCalledWith(expect.any(NextRequest), siteId);
    expect(isSiteSkillManager).toHaveBeenCalledWith(siteId, 'manager-1');
    isInternalServiceRequest.mockReturnValue(true);
    isSiteSkillManager.mockClear();
    expect((await post(request(), context())).status).toBe(200);
    expect(isSiteSkillManager).not.toHaveBeenCalled();
  });

  it('fails closed when the site role cannot be checked', async () => {
    isSiteSkillManager.mockRejectedValueOnce(new Error('DB unavailable'));
    expect((await post(request(), context())).status).toBe(500);
    expect(syncWorkflowDefinition).not.toHaveBeenCalled();
    expect(materializeRunFromGraph).not.toHaveBeenCalled();
  });
});