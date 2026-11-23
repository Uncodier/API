import { visitorSessionAuthorizationService } from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';
import { readSupportRequest } from '../request';
import { checkDuplicateOriginMessage } from '../duplicate-message';

jest.mock('@/lib/services/visitor-identity/VisitorSessionAuthorizationService', () => ({
  visitorSessionAuthorizationService: { authorizeBrowserRequest: jest.fn(async () => null) },
}));
jest.mock('@/lib/security/api-key-credential', () => ({extractApiKeyCredential: () => null, isServiceApiKeyCredential: async () => true}));
jest.mock('../agent-data', () => ({ isValidUUID: () => true }));
jest.mock('../duplicate-message', () => ({ checkDuplicateOriginMessage: jest.fn(async () => ({ isDuplicate: true })) }));
jest.mock('@/lib/security/request-rate-limit', () => ({ isInternalServiceRequest: () => true }));
jest.mock('@/lib/services/social-comments/persistence', () => ({ findCommentProposal: jest.fn() }));

it('does not mistake a different overlapping reply for the Zavu input response', async () => {
  jest.clearAllMocks();
  const body = { site_id: 'site', userId: 'user', message: 'New question', origin_message_id: 'provider',
    custom_data: { source: 'zavu_inbound_message', connection_id: 'connection' } };
  const result = await readSupportRequest(new Request('https://example.test/support', {
    method: 'POST', body: JSON.stringify(body),
  }));
  expect(result).toMatchObject({ body });
  expect(checkDuplicateOriginMessage).not.toHaveBeenCalled();
});

it('preserves the legacy duplicate check for other integrations', async () => {
  jest.clearAllMocks();
  const result = await readSupportRequest(new Request('https://example.test/support', {
    method: 'POST', body: JSON.stringify({ site_id: 'site', message: 'Hello', origin_message_id: 'provider' }),
  }));
  expect(result).toBeInstanceOf(Response);
  expect(checkDuplicateOriginMessage).toHaveBeenCalledTimes(1);
});

it('removes the private workflow assertion before any model or message handling', async () => {
  const ticket = 'synthetic.assertion';
  const result = await readSupportRequest(new Request('https://example.test/support', {
    method: 'POST', body: JSON.stringify({ site_id: 'site', message: 'Hello', custom_data: { connector_visitor_turn: ticket } }),
  }));
  expect(result).not.toBeInstanceOf(Response);
  if (result instanceof Response) throw new Error('Expected a parsed support turn');
  expect(result.visitorTurn).toBe(ticket);
  expect(result.body).not.toHaveProperty('custom_data');
});


it('ignores browser routing and agent claims just like workflow admission',async () => {
  jest.mocked(visitorSessionAuthorizationService.authorizeBrowserRequest).mockResolvedValueOnce({siteId:'site',visitorId:'visitor',sessionId:'session',leadId:null});
  jest.mocked(checkDuplicateOriginMessage).mockResolvedValueOnce({isDuplicate:false});
  const parsed = await readSupportRequest(new Request('https://example.test/support',{method:'POST',body:JSON.stringify({
    site_id:'site',session_id:'session',agentId:'attacker-selected',userId:'owner',origin:'sms',channel_delivery:true,message:'Hello'})}));
  if (parsed instanceof Response) throw new Error('Expected canonical web turn');
  expect(parsed.body).toMatchObject({site_id:'site',visitor_id:'visitor',origin:'website_chat',channel_delivery:false});
  expect(parsed.body.agentId).toBeUndefined(); expect(parsed.body.userId).toBeUndefined();
});
