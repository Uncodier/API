// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const authorizeBrowserRequest = jest.fn();
const customerSupportMessage = jest.fn();
const hasAuthenticatedPrincipal = jest.fn();
const isInternalServiceRequest = jest.fn();
const canAccessSite = jest.fn();
const logError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

jest.unstable_mockModule('@/lib/services/visitor-identity/VisitorSessionAuthorizationService', () => ({
  visitorSessionAuthorizationService: { authorizeBrowserRequest },
  visitorAuthorizationErrorResponse: () => null,
}));
jest.unstable_mockModule('@/lib/services/workflow-service', () => ({
  WorkflowService: { getInstance: () => ({ customerSupportMessage }) },
}));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({ hasAuthenticatedPrincipal, isInternalServiceRequest }));
jest.unstable_mockModule('@/lib/security/site-access', () => ({ canAccessSite }));

const { POST } = await import('../customerSupport/route');

const request = (clientMessageId = 'client-send-1', message = 'Hello') => new NextRequest(
  'https://api.example/api/workflow/customerSupport',
  {
    method: 'POST',
    body: JSON.stringify({
      site_id: 'untrusted-site',
      session_id: 'session-1',
      visitor_id: 'untrusted-visitor',
      client_message_id: clientMessageId,
      origin: 'website_chat',
      message,
    }),
  },
);

beforeEach(() => {
  jest.clearAllMocks();
  authorizeBrowserRequest.mockResolvedValue({
    siteId: 'canonical-site', sessionId: 'session-1', visitorId: 'canonical-visitor', leadId: null,
  });
  customerSupportMessage.mockResolvedValue({ success: true, workflowId: 'wf-1', runId: 'run-1', status: 'running' });
  hasAuthenticatedPrincipal.mockReturnValue(false);
  isInternalServiceRequest.mockReturnValue(false);
  canAccessSite.mockResolvedValue(false);
});

it('starts customer support asynchronously and returns an accepted receipt, not a long response', async () => {
  const response = await POST(request());
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    success: true, data: { status: 'running', workflowId: 'wf-1', runId: 'run-1' },
  });
  expect(customerSupportMessage).toHaveBeenCalledWith(
    expect.objectContaining({ site_id: 'canonical-site', visitor_id: 'canonical-visitor' }),
    expect.objectContaining({ async: true, taskQueue: 'high' }),
  );
});

it('uses a session-scoped stable message identity for retries, but a new identity for new sends', async () => {
  await POST(request('client-send-1'));
  await POST(request('client-send-1'));
  await POST(request('client-send-2'));
  const calls = customerSupportMessage.mock.calls;
  expect(calls[0][0].origin_message_id).toMatch(/^[a-f0-9]{64}$/);
  expect(calls[0][0].origin_message_id).toBe(calls[1][0].origin_message_id);
  expect(calls[0][1].workflowId).toBe(calls[1][1].workflowId);
  expect(calls[2][0].origin_message_id).not.toBe(calls[0][0].origin_message_id);
});

it('does not start Temporal when authorization fails', async () => {
  authorizeBrowserRequest.mockRejectedValueOnce(new Error('Forbidden'));
  expect((await POST(request())).status).toBe(500);
  expect(customerSupportMessage).not.toHaveBeenCalled();
});

afterAll(() => logError.mockRestore());

it('rejects unauthenticated or cross-site service calls before starting Temporal', async () => {
  authorizeBrowserRequest.mockResolvedValue(null);
  expect((await POST(request())).status).toBe(401);
  expect(canAccessSite).not.toHaveBeenCalled();
  hasAuthenticatedPrincipal.mockReturnValue(true);
  expect((await POST(request())).status).toBe(403);
  expect(canAccessSite).toHaveBeenCalledWith(expect.any(NextRequest), 'untrusted-site');
  canAccessSite.mockResolvedValue(true);
  expect((await POST(request())).status).toBe(403);
  expect(isInternalServiceRequest).toHaveBeenCalled();
  expect(customerSupportMessage).not.toHaveBeenCalled();
});