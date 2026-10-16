jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init: any = {}) => ({ status: init.status || 200, body }) } }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
jest.mock('@/lib/messaging/exact-delivery-context', () => ({ loadExactDeliveryContext: jest.fn() }));
jest.mock('@/lib/messaging/exact-delivery', () => ({ sendExactDelivery: jest.fn() }));
jest.mock('@/lib/messaging/exact-delivery-receipt', () => ({ claimExactDelivery: jest.fn(), finishExactDelivery: jest.fn() }));
jest.mock('@/lib/services/outreach/recipients', () => ({ resolveOutreachRecipient: jest.fn() }));
jest.mock('@/lib/services/outreach/recipient-repository', () => ({ loadOutreachConversations: jest.fn(async () => []) }));
import { POST } from '@/app/api/agents/tools/sendExactDelivery/route';
import { canAccessSite } from '@/lib/security/site-access';
import { loadExactDeliveryContext } from '../exact-delivery-context';
import { sendExactDelivery } from '../exact-delivery';
import { claimExactDelivery, finishExactDelivery } from '../exact-delivery-receipt';
import { resolveOutreachRecipient } from '@/lib/services/outreach/recipients';
const id = '11111111-1111-4111-8111-111111111111';
let context: any;
const request = (body: any = {}) => ({ json: async () => ({ site_id: id, channel: 'email', message_id: id, ...body }) }) as Request;
beforeEach(() => {
  jest.clearAllMocks();
  context = { connectionId: 'selected', hasStoredConnection: true, customData: {}, leadId: id,
    conversationId: id, message: { id, role: 'assistant', content: 'Stored content', custom_data: { status: 'sending' } } };
  (canAccessSite as jest.Mock).mockResolvedValue(true);
  (loadExactDeliveryContext as jest.Mock).mockImplementation(async () => context);
  (resolveOutreachRecipient as jest.Mock).mockReturnValue({ recipient: 'stored@example.com' });
  (claimExactDelivery as jest.Mock).mockResolvedValue('attempt');
  (sendExactDelivery as jest.Mock).mockImplementation(async (input: any) => { await input.before_dispatch(); return { success: true, messageId: 'provider-id' }; });
});
test('requires authorization before reading service-role delivery context', async () => {
  (canAccessSite as jest.Mock).mockResolvedValue(false);
  expect((await POST(request())).status).toBe(403);
  expect(loadExactDeliveryContext).not.toHaveBeenCalled(); expect(sendExactDelivery).not.toHaveBeenCalled();
});
test.each(['missing-marker', 'user-message', 'no-connection'])('refuses %s instead of treating client routing as persisted authority', async scenario => {
  if (scenario === 'missing-marker') context.hasStoredConnection = false;
  if (scenario === 'user-message') context.message.role = 'user';
  if (scenario === 'no-connection') context.connectionId = '';
  expect((await POST(request({ connection_id: 'injected' }))).status).toBe(409);
  expect(sendExactDelivery).not.toHaveBeenCalled();
});
test('uses stored recipient/content, ignores request voice/subject/context overrides and records receipt', async () => {
  expect((await POST(request({ to: 'attacker@example.com', message: 'Injected content', subject: 'Injected subject', objective: 'Injected objective' }))).status).toBe(200);
  expect(sendExactDelivery).toHaveBeenCalledWith(expect.objectContaining({ connection_id: 'selected', to: 'stored@example.com', message: 'Stored content' }));
  const input = (sendExactDelivery as jest.Mock).mock.calls[0][0];
  expect(input.subject).toBeUndefined(); expect(input.objective).toBeUndefined();
  expect(claimExactDelivery).toHaveBeenCalled(); expect(finishExactDelivery).toHaveBeenCalledWith(id, 'attempt', expect.objectContaining({ success: true }));
});
test('accepted retry returns previous receipt without provider dispatch', async () => {
  context.customData.exact_delivery_receipt = { state: 'accepted', connection_id: 'selected', result: { success: true, messageId: 'previous' } };
  expect((await POST(request())).status).toBe(200);
  expect(sendExactDelivery).not.toHaveBeenCalled();
});
test('cross-site unavailable context fails closed', async () => {
  (loadExactDeliveryContext as jest.Mock).mockRejectedValue(new Error('Foreign message'));
  expect((await POST(request())).status).toBe(409); expect(sendExactDelivery).not.toHaveBeenCalled();
});