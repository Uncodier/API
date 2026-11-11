import { readSupportRequest } from '../request';
import { checkDuplicateOriginMessage } from '../duplicate-message';

jest.mock('@/lib/services/visitor-identity/VisitorSessionAuthorizationService', () => ({
  visitorSessionAuthorizationService: { authorizeBrowserRequest: async () => null },
}));
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