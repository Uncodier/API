import { randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';

const mockRpc = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockLookup = jest.fn();
const mockFilter = jest.fn();
function mockTableQuery(table: string) {
  const query = {
    select: () => query,
    eq: (key: string, value: unknown) => { mockFilter(table, key, value); return query; },
    maybeSingle: () => mockLookup(table),
    insert: (value: unknown) => mockInsert(table, value),
    update: (value: unknown) => {
      mockUpdate(table, value);
      return { eq: async () => ({ error: null }) };
    },
  };
  return query;
}
const mockFrom = jest.fn(mockTableQuery);
const mockGetUser = jest.fn();
const mockCreateClient = jest.fn((..._args: unknown[]) => ({ auth: { getUser: mockGetUser } }));
const mockWorkflow = jest.fn();
const mockWorkflowStatus = jest.fn();

jest.mock('@supabase/supabase-js', () => ({ createClient: (...args: unknown[]) => mockCreateClient(...args) }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {
  rpc: (...args: unknown[]) => mockRpc(...args),
  from: (table: string) => mockFrom(table),
} }));
jest.mock('@/lib/services/workflow-service', () => ({ WorkflowService: {
  getInstance: () => ({
    executeWorkflow: (...args: unknown[]) => mockWorkflow(...args),
    getFinishedWorkflowResult: (...args: unknown[]) => mockWorkflowStatus(...args),
  }),
} }));
jest.mock('next/server', () => ({ NextResponse: {
  json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
} }));

import { GET, POST } from '../route';

const siteId = '10000000-0000-4000-8000-000000000001';
const userId = '20000000-0000-4000-8000-000000000001';
const otherUserId = '20000000-0000-4000-8000-000000000002';
const billingId = '30000000-0000-4000-8000-000000000001';
const workflowId = `site-setup-${siteId}-1791331200000`;
const token = randomBytes(48).toString('hex');
const validBilling = {
  success: true, outcome: 'initialized', billing_id: billingId,
  credits_granted: 1, credits_available: 1,
};

function request(body: unknown = { site_id: siteId }, headers: Record<string, string> = {}) {
  return new Request('https://api.example.test/api/site/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  }) as NextRequest;
}

function statusRequest(id = workflowId, headers: Record<string, string> = {}) {
  const url = new URL('https://api.example.test/api/site/setup');
  url.searchParams.set('workflow_id', id);
  return new Request(url, { headers: { authorization: `Bearer ${token}`, ...headers } }) as NextRequest;
}

function expectNoLaunch() {
  expect(mockWorkflow).not.toHaveBeenCalled();
  expect(mockInsert).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
}

describe('site setup authorization and atomic billing gate', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockCreateClient.mockImplementation(() => ({ auth: { getUser: mockGetUser } }));
    mockGetUser.mockResolvedValue({ data: { user: { id: userId, role: 'authenticated', is_anonymous: false } }, error: null });
    mockLookup.mockImplementation(async (table: string) => ({ data: table === 'sites' ? { id: siteId } : null, error: null }));
    mockFrom.mockImplementation(mockTableQuery);
    mockInsert.mockResolvedValue({ error: null });
    mockRpc.mockResolvedValue({ data: validBilling, error: null });
    mockWorkflow.mockImplementation(async (_type, _args, options) => ({ success: true,
      workflowId: options.workflowId, executionId: 'synthetic', runId: 'synthetic', status: 'running' }));
    mockWorkflowStatus.mockResolvedValue({ success: true, workflowId, runId: 'synthetic', status: 'running' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('rejects missing credentials and forged identity headers without any privileged access', async () => {
    const response = await POST(request(undefined, {
      authorization: '', 'x-auth-user-id': userId, 'x-auth-validated': 'true',
      'x-api-key-data': JSON.stringify({ isService: true, user_id: userId }),
    }));
    expect(response.status).toBe(401);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expectNoLaunch();
  });

  it.each([
    { data: { user: null }, error: { message: 'Synthetic expired session' } },
    { data: { user: { id: userId, role: 'authenticated', is_anonymous: true } }, error: null },
    { data: { user: { id: userId, role: 'service_role' } }, error: null },
  ])('rejects invalid or non-user sessions: %j', async (auth) => {
    mockGetUser.mockResolvedValue(auth);
    expect((await POST(request())).status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expectNoLaunch();
  });

  it('rejects API key credentials even alongside a user token', async () => {
    expect((await POST(request(undefined, { 'x-api-key': randomBytes(32).toString('hex') }))).status).toBe(401);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expectNoLaunch();
  });

  it('rejects cross-tenant setup without billing or workflow writes', async () => {
    mockLookup.mockResolvedValue({ data: null, error: null });
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mockFilter).toHaveBeenCalledWith('sites', 'user_id', userId);
    expect(mockFilter).toHaveBeenCalledWith('site_members', 'user_id', userId);
    expect(mockFilter).toHaveBeenCalledWith('site_members', 'status', 'active');
    expect(mockRpc).not.toHaveBeenCalled();
    expectNoLaunch();
  });

  it.each(['marketing', 'collaborator'])('rejects non-manager role %s', async (role) => {
    mockLookup.mockImplementation(async (table: string) => ({ data: table === 'site_members' ? { role } : null, error: null }));
    expect((await POST(request())).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
    expectNoLaunch();
  });

  it.each(['owner', 'admin'])('permits active manager role %s', async (role) => {
    mockLookup.mockImplementation(async (table: string) => ({ data: table === 'site_members' ? { role } : null, error: null }));
    expect((await POST(request())).status).toBe(200);
    expect(mockWorkflow).toHaveBeenCalledTimes(1);
  });

  it('fails closed on site authorization lookup errors', async () => {
    mockLookup.mockResolvedValue({ data: null, error: { message: 'Synthetic unavailable lookup' } });
    expect((await POST(request())).status).toBe(503);
    expect(mockRpc).not.toHaveBeenCalled();
    expectNoLaunch();
  });

  it('rejects a forged request user_id before billing or workflow writes', async () => {
    expect((await POST(request({ site_id: siteId, user_id: otherUserId }))).status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expectNoLaunch();
  });

  it.each([
    null, [], {}, { site_id: 42 }, { site_id: 'invalid' },
    { site_id: siteId, user_id: 'invalid' }, { site_id: siteId, setup_type: 'custom' },
    { site_id: siteId, options: [] }, { site_id: siteId, options: { enable_chat: 'false' } },
    { site_id: siteId, options: { default_timezone: 'Invalid/Timezone' } },
  ])('validates the request before privileged access: %j', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expectNoLaunch();
  });

  it('returns 400 for malformed JSON', async () => {
    const malformed = new Request('https://api.example.test/api/site/setup', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{',
    }) as NextRequest;
    expect((await POST(malformed)).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
    expectNoLaunch();
  });

  it.each([
    { data: null, error: { message: 'Synthetic unavailable database' } },
    { data: validBilling, error: { message: 'Synthetic RPC error' } },
    { data: { success: false, error: 'Synthetic initialization refusal' }, error: null },
    { data: null, error: null }, { data: { success: true }, error: null },
    { data: { ...validBilling, success: 'true' }, error: null },
    { data: { ...validBilling, outcome: 'unexpected' }, error: null },
    { data: { ...validBilling, billing_id: 'invalid' }, error: null },
    { data: { ...validBilling, credits_granted: -1 }, error: null },
    { data: { ...validBilling, credits_granted: Infinity }, error: null },
    { data: { ...validBilling, credits_available: '1' }, error: null },
    { data: { ...validBilling, credits_available: NaN }, error: null },
    { data: [validBilling], error: null }, undefined,
  ])('returns safe 503 without workflow or financial fallback for invalid RPC result: %j', async (rpcResult) => {
    mockRpc.mockResolvedValue(rpcResult);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: {
      code: 'BILLING_INITIALIZATION_FAILED',
      message: 'Site billing could not be initialized. Please retry setup later',
    } });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalledWith('billing');
    expect(mockFrom).not.toHaveBeenCalledWith('credit_transactions');
    expect(mockFrom).not.toHaveBeenCalledWith('payments');
    expectNoLaunch();
  });

  it('returns safe 503 if the billing RPC throws', async () => {
    mockRpc.mockRejectedValue(new Error('Synthetic database exception'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('BILLING_INITIALIZATION_FAILED');
    expectNoLaunch();
  });

  it.each(['initialized', 'already_initialized'])('launches unchanged after %s with no caller allowance', async (outcome) => {
    mockRpc.mockResolvedValue({ data: { ...validBilling, outcome, credits_granted: 0, credits_available: 0 }, error: null });
    const response = await POST(request({
      site_id: siteId, user_id: userId, setup_type: 'advanced', credits_available: 999, p_allowance: 999,
      options: { enable_chat: false, default_language: 'es', credits_available: 999, p_allowance: 999 },
    }, { 'x-auth-user-id': otherUserId, 'x-api-key-data': JSON.stringify({ isService: true }) }));
    expect(response.status).toBe(200);
    expect(mockGetUser).toHaveBeenCalledWith(token);
    expect(mockCreateClient).toHaveBeenCalledWith(
      process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } },
    );
    expect(mockRpc).toHaveBeenCalledWith('initialize_site_billing', { p_site_id: siteId });
    expect(mockInsert).toHaveBeenCalledWith('settings', { site_id: siteId, default_locale: 'es' });
    expect(mockFrom.mock.calls.every(([table]) => ['sites', 'settings'].includes(table))).toBe(true);
    expect(mockWorkflow).toHaveBeenCalledWith('siteSetupWorkflow', {
      site_id: siteId, user_id: userId, setup_type: 'advanced', options: {
        enable_analytics: true, enable_chat: false, enable_leads: true, enable_email_tracking: true,
        default_timezone: 'UTC', default_language: 'es',
      },
    }, {
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'default', workflowId: expect.stringMatching(/^site-setup-/),
      async: true,
    });
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockWorkflow.mock.invocationCallOrder[0]);
    expect((await response.json()).data.message).toBe('Site setup was accepted. Completion is not yet confirmed.');
  });

  it('uses the authenticated identity when user_id is omitted', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mockWorkflow.mock.calls[0][1].user_id).toBe(userId);
  });

  it('preserves best-effort settings persistence after confirmed billing', async () => {
    mockInsert.mockResolvedValue({ error: { message: 'Synthetic settings failure' } });
    expect((await POST(request())).status).toBe(200);
    expect(mockWorkflow).toHaveBeenCalledTimes(1);
  });

  it('cannot overwrite normalized workflow defaults with an unsupported language', async () => {
    expect((await POST(request({ site_id: siteId, options: { default_language: 'unsupported' } }))).status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith('settings', { site_id: siteId, default_locale: 'en' });
    expect(mockWorkflow.mock.calls[0][1].options.default_language).toBe('en');
  });

  it('does not expose upstream workflow launch errors', async () => {
    mockWorkflow.mockResolvedValue({ success: false, error: { code: 'UPSTREAM', message: 'Synthetic private upstream detail' } });
    const response = await POST(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toEqual({ code: 'SETUP_UNCONFIRMED',
      message: 'Site setup could not be confirmed. Check its status before retrying.' });
    expect(body.data.workflow_id).toMatch(new RegExp(`^site-setup-${siteId}-`));
    expect(mockWorkflow).toHaveBeenCalledTimes(1);
  });

  it('requires authentication and manager access before workflow status reads', async () => {
    expect((await GET(statusRequest(workflowId, { authorization: '' }))).status).toBe(401);
    mockLookup.mockResolvedValue({ data: null, error: null });
    expect((await GET(statusRequest())).status).toBe(403);
    expect(mockWorkflowStatus).not.toHaveBeenCalled();
  });

  it('does not use a caller site_id to authorize an unrelated workflow', async () => {
    expect((await GET(statusRequest('unrelated-workflow'))).status).toBe(400);
    expect(mockWorkflowStatus).not.toHaveBeenCalled();
  });

  it('reads status only for the site embedded in a valid setup workflow ID', async () => {
    const response = await GET(statusRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mockFilter).toHaveBeenCalledWith('sites', 'id', siteId);
    expect(mockWorkflowStatus).toHaveBeenCalledWith(workflowId);
    expect(mockRpc).not.toHaveBeenCalled();
    expectNoLaunch();
  });

  it('does not expose upstream workflow status errors', async () => {
    mockWorkflowStatus.mockResolvedValue({ success: false, workflowId, error: { code: 'UPSTREAM', message: 'Synthetic private upstream detail' } });
    const response = await GET(statusRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: {
      code: 'WORKFLOW_STATUS_ERROR', message: 'Unable to retrieve the site setup workflow status',
    } });
  });

  it('does not expose a mismatched upstream workflow status', async () => {
    mockWorkflowStatus.mockResolvedValue({ success: true, workflowId: 'unrelated-workflow', status: 'running' });
    const response = await GET(statusRequest());
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('WORKFLOW_STATUS_ERROR');
  });

  it('uses the existing subscribed default queue and respects configured worker queue', async () => {
    const previous = process.env.WORKFLOW_TASK_QUEUE;
    try {
      delete process.env.WORKFLOW_TASK_QUEUE;
      await POST(request({ site_id: siteId, company_name: 'forged', contact_email: 'forged', url: 'forged' }));
      expect(mockWorkflow.mock.calls[0][2].taskQueue).toBe('default');
      expect(mockWorkflow.mock.calls[0][1]).not.toHaveProperty('company_name');
      expect(mockWorkflow.mock.calls[0][1]).not.toHaveProperty('contact_email');
      process.env.WORKFLOW_TASK_QUEUE = 'configured-worker';
      await POST(request());
      expect(mockWorkflow.mock.calls[1][2].taskQueue).toBe('configured-worker');
    } finally {
      if (previous === undefined) delete process.env.WORKFLOW_TASK_QUEUE;
      else process.env.WORKFLOW_TASK_QUEUE = previous;
    }
  });

  it('reports explicit partial completion with safe step status, never raw errors or contact data', async () => {
    mockWorkflowStatus.mockResolvedValue({ success: true, workflowId, status: 'completed', data: {
      success: true, status: 'partial', contact_email: 'private', errors: ['private'],
      steps: { agents: { status: 'completed' }, segments: { status: 'skipped', reason: 'missing_site_url' },
        account_manager: { status: 'skipped', reason: 'private' } },
    } });
    const response = await GET(statusRequest());
    const body = await response.json();
    expect(body.data).toMatchObject({ status: 'completed', setup_status: 'partial', cause: 'SETUP_PARTIAL',
      steps: { agents: 'completed', segments: 'skipped' }, step_causes: { segments: 'missing_site_url' } });
    expect(JSON.stringify(body)).not.toContain('private');
    expectNoLaunch();
  });

  it.each([
    [{ success: true, status: 'completed' }, 'complete'],
    [{ success: true }, 'unconfirmed'],
    [{ success: false, status: 'failed' }, 'failed'],
  ])('does not infer setup completion from Temporal completion alone (%j)', async (data, expected) => {
    mockWorkflowStatus.mockResolvedValue({ success: true, workflowId, status: 'completed', data });
    expect((await (await GET(statusRequest())).json()).data.setup_status).toBe(expected);
  });

  it('returns a safe partial state for a terminal failed execution without replay', async () => {
    mockWorkflowStatus.mockResolvedValue({ success: false, workflowId, status: 'FAILED', error: { message: 'private' } });
    const response = await GET(statusRequest());
    expect((await response.json()).data).toMatchObject({ setup_status: 'failed', cause: 'WORKFLOW_DID_NOT_COMPLETE' });
    expectNoLaunch();
  });

  it('does not overwrite saved locale for the minimum site-only request', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockWorkflow).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized and non-JSON requests before privileged writes', async () => {
    expect((await POST(request({ site_id: siteId, padding: 'x'.repeat(5_000) }))).status).toBe(413);
    expect((await POST(request(undefined, { 'content-type': 'text/plain' }))).status).toBe(415);
    expect(mockRpc).not.toHaveBeenCalled();
    expectNoLaunch();
  });

  it('does not dispatch after an ambiguous billing deadline and never retries the RPC', async () => {
    jest.useFakeTimers();
    try {
      mockRpc.mockReturnValue(new Promise(() => {}));
      const operation = POST(request());
      await jest.advanceTimersByTimeAsync(3_100);
      const response = await operation;
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe('BILLING_INITIALIZATION_FAILED');
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expectNoLaunch();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not perform privileged work after a stalled authentication check', async () => {
    jest.useFakeTimers();
    try {
      mockGetUser.mockReturnValue(new Promise(() => {}));
      const operation = POST(request());
      await jest.advanceTimersByTimeAsync(3_100);
      expect((await operation).status).toBe(503);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockFrom).not.toHaveBeenCalled();
      expectNoLaunch();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains the server workflow identifier after an ambiguous start deadline without retry', async () => {
    jest.useFakeTimers();
    try {
      mockWorkflow.mockReturnValue(new Promise(() => {}));
      const operation = POST(request());
      await jest.advanceTimersByTimeAsync(6_100);
      const response = await operation;
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error.code).toBe('SETUP_UNCONFIRMED');
      expect(body.data.workflow_id).toBe(mockWorkflow.mock.calls[0][2].workflowId);
      expect(mockWorkflow).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});