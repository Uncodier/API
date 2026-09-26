// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const authorizeBrowserRequest = jest.fn();
const getFinishedWorkflowResult = jest.fn();

jest.unstable_mockModule('@/lib/services/visitor-identity/VisitorSessionAuthorizationService', () => ({
  visitorSessionAuthorizationService: { authorizeBrowserRequest },
  visitorAuthorizationErrorResponse: () => null,
}));
jest.unstable_mockModule('@/lib/services/workflow-service', () => ({
  WorkflowService: { getInstance: () => ({ getFinishedWorkflowResult }) },
}));

const { POST } = await import('../customerSupport/status/route');
const request = (body: Record<string, unknown>) => new NextRequest(
  'https://api.example/api/workflow/customerSupport/status',
  { method: 'POST', body: JSON.stringify(body) },
);
const payload = { site_id: 'untrusted', session_id: 'session-1', client_message_id: 'client-1', message: 'Hello' };

beforeEach(() => {
  jest.clearAllMocks();
  authorizeBrowserRequest.mockResolvedValue({ siteId: 'canonical-site', sessionId: 'session-1', visitorId: 'visitor-1' });
  getFinishedWorkflowResult.mockResolvedValue({ success: true, status: 'running' });
});

it('binds the poll to the authorized site and never waits for a running result', async () => {
  expect(await (await POST(request(payload))).json()).toEqual({ success: true, data: { status: 'running' } });
  expect(getFinishedWorkflowResult).toHaveBeenCalledWith(expect.stringMatching(/^customer-support-message-canonical-site-[a-f0-9]{64}$/));
  getFinishedWorkflowResult.mockResolvedValueOnce({ success: true, status: 'completed', data: {
    success: true, data: { conversation_id: 'conversation-1', messages: { assistant: { content: 'Hi' } } },
  } });
  expect(await (await POST(request(payload))).json()).toMatchObject({
    success: true, data: { success: true, data: { conversation_id: 'conversation-1' } },
  });
});

it('rejects unauthorized and invalid polls before querying Temporal', async () => {
  authorizeBrowserRequest.mockResolvedValueOnce(null);
  expect((await POST(request(payload))).status).toBe(403);
  expect((await POST(request({ ...payload, client_message_id: '' }))).status).toBe(400);
  expect(getFinishedWorkflowResult).not.toHaveBeenCalled();
});