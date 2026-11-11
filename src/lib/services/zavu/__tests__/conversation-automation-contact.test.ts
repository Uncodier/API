import { normalizeWhatsAppAutomationRecipient, reconcileConversationHumanEvents } from '../conversation-automation-contact';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { schema: jest.fn() } }));

const rpc = jest.fn();
const input = () => ({ siteId: 'site', conversationId: 'conversation', metadata: {
  source: 'zavu_inbound_message', channel: 'whatsapp', connection_id: 'connection',
  zavu_sender_id: 'sender', zavu_from: 'whatsapp:+5215555550123',
} });

beforeEach(() => {
  jest.clearAllMocks();
  rpc.mockReset().mockResolvedValue({ data: { state: 'reconciled', conversation_id: 'conversation', applied_count: 0 }, error: null });
  (supabaseAdmin.schema as jest.Mock).mockReturnValue({ rpc });
});

describe('exact WhatsApp automation recipient normalization', () => {
  it.each(['5215555550123', '+5215555550123', 'whatsapp:5215555550123', 'whatsapp:+5215555550123'])
  ('preserves every digit in %s', value => {
    expect(normalizeWhatsAppAutomationRecipient(value)).toBe('+5215555550123');
  });

  it('does not rewrite the Mexican mobile prefix or guess country codes', () => {
    expect(normalizeWhatsAppAutomationRecipient('+5215555550123')).not.toBe(normalizeWhatsAppAutomationRecipient('+525555550123'));
    expect(normalizeWhatsAppAutomationRecipient('5550123')).toBe('+5550123');
  });

  it.each([undefined, null, 15555550123, {}, [], '', ' ', ' +15555550123', '+15555550123 ',
    'whatsapp:+1 555 555 0123', '+1-555-555-0123', 'WHATSAPP:+15555550123', 'whatsapp:whatsapp:+15555550123',
    '++15555550123', '0015555550123', '+05555550123', '123456', '1234567890123456',
    '15555550123@s.whatsapp.net', '15555550123@g.us'])('rejects ambiguous or invalid recipient %p', value => {
    expect(() => normalizeWhatsAppAutomationRecipient(value)).toThrow('CUSTOMER_SUPPORT_SNOOZE_CONTACT_INVALID');
  });
});

it('reconciles only the exact saved inbound contact and conversation, with no extra metadata forwarded', async () => {
  const request = input();
  await expect(reconcileConversationHumanEvents(request)).resolves.toBeUndefined();
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('reconcile_conversation_human_events', {
    p_site_id: 'site', p_connection_id: 'connection', p_sender_id: 'sender',
    p_recipient: '+5215555550123', p_conversation_id: 'conversation',
  });
  expect(request).toEqual(input());
});

it.each([0, 1, 3])('accepts successful reconciliation with %i applied events', async applied_count => {
  rpc.mockResolvedValue({ data: { state: 'reconciled', conversation_id: 'conversation', applied_count }, error: null });
  await expect(reconcileConversationHumanEvents(input())).resolves.toBeUndefined();
});

it.each([null, undefined, {}, [], [{ state: 'reconciled', conversation_id: 'conversation' }],
  { state: 'pending', conversation_id: 'conversation' }, { state: 'applied', conversation_id: 'conversation' },
  { state: 'reconciled' }, { state: 'reconciled', conversation_id: 'other' },
  { state: 'reconciled', conversation_id: null }, { state: 'reconciled', conversation_id: ['conversation'] }])
('fails closed on malformed or wrong-scope reconciliation result %p', async data => {
  rpc.mockResolvedValue({ data, error: null });
  await expect(reconcileConversationHumanEvents(input())).rejects.toThrow('CUSTOMER_SUPPORT_SNOOZE_RECONCILIATION_FAILED');
});

it('fails closed when the migration/RPC is missing even with successful-looking data', async () => {
  rpc.mockResolvedValue({ data: { state: 'reconciled', conversation_id: 'conversation' }, error: { code: 'PGRST202' } });
  await expect(reconcileConversationHumanEvents(input())).rejects.toThrow('CUSTOMER_SUPPORT_SNOOZE_RECONCILIATION_FAILED');
});

it('propagates rejected transport requests rather than allowing model work', async () => {
  rpc.mockRejectedValue(new Error('connection refused'));
  await expect(reconcileConversationHumanEvents(input())).rejects.toThrow();
});

it.each([{ siteId: '' }, { conversationId: '' }, { metadata: {} },
  { metadata: { ...input().metadata, connection_id: null } },
  { metadata: { ...input().metadata, zavu_sender_id: '' } },
  { metadata: { ...input().metadata, zavu_from: '+1 (555) 555-0123' } }])
('rejects invalid contact scope before calling the RPC %p', async patch => {
  await expect(reconcileConversationHumanEvents({ ...input(), ...patch } as any)).rejects.toThrow('CUSTOMER_SUPPORT_SNOOZE_CONTACT_INVALID');
  expect(rpc).not.toHaveBeenCalled();
});

it('uses the explicit tenant schema ahead of the generic schema', async () => {
  const previous = process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA;
  process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA = 'tenant_contact_test';
  try {
    await reconcileConversationHumanEvents(input());
    expect(supabaseAdmin.schema).toHaveBeenCalledWith('tenant_contact_test');
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA;
    else process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA = previous;
  }
});