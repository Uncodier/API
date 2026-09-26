// @ts-nocheck -- Jest ESM mocks are dynamically imported under the ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const identity = { siteId: 'canonical-site', sessionId: 'session-1', visitorId: 'visitor-1', leadId: null };
const authorizeBrowserRequest = jest.fn(async () => identity);
const customerSupportMessage = jest.fn(async () => ({ success: true, status: 'running', workflowId: 'wf-1' }));
const getFinishedWorkflowResult = jest.fn(async () => ({ success: true, status: 'running' }));
jest.unstable_mockModule('@/lib/services/visitor-identity/VisitorSessionAuthorizationService', () => ({
  visitorSessionAuthorizationService: { authorizeBrowserRequest }, visitorAuthorizationErrorResponse: () => null,
}));
jest.unstable_mockModule('@/lib/services/workflow-service', () => ({
  WorkflowService: { getInstance: () => ({ customerSupportMessage, getFinishedWorkflowResult }) },
}));
jest.unstable_mockModule('@/lib/security/request-rate-limit', () => ({
  hasAuthenticatedPrincipal: () => false, isInternalServiceRequest: () => false,
}));
jest.unstable_mockModule('@/lib/security/site-access', () => ({ canAccessSite: async () => false }));

const { POST: send } = await import('../customerSupport/route');
const { POST: status } = await import('../customerSupport/status/route');
const payload = { site_id: 'site-1', session_id: 'session-1', client_message_id: 'client-1', message: 'Hello' };
const request = (body: unknown) => new NextRequest('https://api.example/api/workflow/customerSupport', {
  method: 'POST', body: JSON.stringify(body),
});
beforeEach(() => jest.clearAllMocks());

it.each(['', '   ', 'x'.repeat(4001)])('rejects invalid message length at both endpoints: %#', async (message) => {
  expect((await send(request({ ...payload, message }))).status).toBe(400);
  expect((await status(request({ ...payload, message }))).status).toBe(400);
  expect(customerSupportMessage).not.toHaveBeenCalled();
  expect(getFinishedWorkflowResult).not.toHaveBeenCalled();
});

it.each([null, [], 12, { ...payload, client_message_id: 'x'.repeat(129) }])('rejects invalid bodies at both endpoints: %#', async (body) => {
  expect((await send(request(body))).status).toBe(400);
  expect((await status(request(body))).status).toBe(400);
});

it.each(['x'.repeat(4000), '\n'.repeat(3999) + 'x', '😀'.repeat(2000)])('accepts the same boundary message and derives the same identity: %#', async (message) => {
  expect((await send(request({ ...payload, message }))).status).toBe(202);
  expect((await status(request({ ...payload, message }))).status).toBe(200);
  const workflowId = customerSupportMessage.mock.calls[0][1].workflowId;
  expect(getFinishedWorkflowResult).toHaveBeenCalledWith(workflowId);
});

it('forces web origin and removes a visitor-supplied agent instead of trusting the client', async () => {
  await send(request({ ...payload, origin: 'email', agentId: 'foreign-agent' }));
  expect(customerSupportMessage).toHaveBeenCalledWith(expect.objectContaining({ origin: 'website_chat', agentId: undefined }), expect.anything());
});

it('reports terminal workflow failures separately from temporary status failures', async () => {
  getFinishedWorkflowResult.mockResolvedValueOnce({ success: false, error: { code: 'WORKFLOW_FAILED' } });
  const terminal = await status(request(payload));
  expect(terminal.status).toBe(422);
  expect(await terminal.json()).toMatchObject({ status: 'failed' });
  getFinishedWorkflowResult.mockResolvedValueOnce({ success: false, error: { code: 'WORKFLOW_RESULT_UNAVAILABLE' } });
  expect((await status(request(payload))).status).toBe(503);
});