jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../audio-routing', () => ({ resolveAudioRouting: jest.fn(), AudioRoutingError: class extends Error {} }));
import { requireLegacyAudioRouting } from '../audio-message-routing';
import { resolveAudioRouting } from '../audio-routing';
import { supabaseAdmin } from '@/lib/database/supabase-client';

beforeEach(() => {
  jest.clearAllMocks();
  const q: any = { select: () => q, eq: jest.fn(() => q),
    maybeSingle: async () => ({ data: { custom_data: { connection_id: 'legacy:whatsapp' } } }),
  };
  jest.mocked(supabaseAdmin.from).mockReturnValue(q);
  jest.mocked(resolveAudioRouting).mockResolvedValue({ kind: 'legacy-whatsapp', connectionId: 'legacy:whatsapp' });
});
it('loads and validates saved Twilio binding with authoritative conversation scope', async () => {
  await requireLegacyAudioRouting('site', 'conversation', 'message');
  expect(resolveAudioRouting).toHaveBeenCalledWith({ siteId: 'site', conversationId: 'conversation',
    channel: 'whatsapp', connectionId: 'legacy:whatsapp', allowLegacyWhatsApp: true });
});
it('rejects Zavu bindings instead of using an unrelated Twilio account', async () => {
  jest.mocked(resolveAudioRouting).mockResolvedValue({ kind: 'zavu', connectionId: 'wa', senderId: 'sender' });
  await expect(requireLegacyAudioRouting('site', 'conversation', 'message')).rejects.toThrow('selected Zavu adapter');
});
it('requires saved message scope', async () => {
  await expect(requireLegacyAudioRouting('site')).rejects.toThrow('saved message');
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});