jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/security/site-access', () => ({ canAccessSite: jest.fn() }));
jest.mock('../delivery', () => ({ outreachRepository: { history: jest.fn(), segmentBelongsToSite: jest.fn() } }));
jest.mock('../recipient-repository', () => ({ loadOutreachConversations: jest.fn(async () => []) }));
import { assertOutreachGeneration } from '../generation-guard';
import { canAccessSite } from '@/lib/security/site-access';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { outreachRepository } from '../delivery';
import { loadOutreachConversations } from '../recipient-repository';
const request = new Request('http://localhost');
beforeEach(() => { jest.clearAllMocks(); });
test('managed generation rejects unauthorized site before any tenant data query', async () => {
  (canAccessSite as jest.Mock).mockResolvedValue(false);
  await expect(assertOutreachGeneration(request, 'site', 'lead', 'leads_initial_cold_outreach')).rejects.toMatchObject({ status: 403 });
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});
test.each(['sms', 'telegram', 'voice'])('generation guard supports %s-only sites and defers inaccessible recipient', async channel => {
  (canAccessSite as jest.Mock).mockResolvedValue(true);
  const lead: any = { id: 'lead', site_id: 'site', status: 'new', phone: '+15551234567', voice_call_consent_status: 'granted', voice_call_consent_at: '2026-01-01T12:00:00Z' };
  const settings = { activities: { leads_initial_cold_outreach: { status: 'active', all_segments: true, channel_accounts: { [channel]: ['selected'] } } },
    channels: { connections: [{ id: 'selected', type: channel, status: 'connected', zavu_sender_id: 'sender' }] } };
  (supabaseAdmin.from as jest.Mock).mockImplementation(table => {
    const query: any = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: table === 'leads' ? lead : settings }) }; return query;
  });
  (loadOutreachConversations as jest.Mock).mockResolvedValue(channel === 'telegram' ? [{ id: 'c', site_id: 'site', lead_id: 'lead', channel, custom_data: { chat_id: 'known-chat' } }] : []);
  (outreachRepository.history as jest.Mock).mockResolvedValue([]);
  expect(await assertOutreachGeneration(request, 'site', 'lead', 'leads_initial_cold_outreach')).toMatchObject({ channels: [channel], recipients: { [channel]: { recipient: channel === 'telegram' ? 'known-chat' : lead.phone } } });
  lead.phone = undefined; lead.voice_call_consent_status = 'revoked';
  (loadOutreachConversations as jest.Mock).mockResolvedValue([]);
  await expect(assertOutreachGeneration(request, 'site', 'lead', 'leads_initial_cold_outreach')).rejects.toMatchObject({ message: 'No accessible recipient on selected channels' });
});
test('managed generation loads tenant lead and checks current audience before any AI', async () => {
  (canAccessSite as jest.Mock).mockResolvedValue(true);
  const filters: any[] = [];
  const lead = { id: 'lead', site_id: 'site', status: 'new', email: 'trusted@example.com' };
  const settings = { activities: { leads_initial_cold_outreach: { status: 'active', all_segments: true, channel_accounts: { email: ['hi'], whatsapp: [] } } },
    channels: { connections: [{ id: 'hi', type: 'email', status: 'connected', zavu_sender_id: 'sender' }] } };
  (supabaseAdmin.from as jest.Mock).mockImplementation(table => {
    const query: any = { select: () => query, eq: (key: string, value: string) => { filters.push([table, key, value]); return query; }, maybeSingle: async () => ({ data: table === 'leads' ? lead : settings }) };
    return query;
  });
  (outreachRepository.history as jest.Mock).mockResolvedValue([]);
  expect(await assertOutreachGeneration(request, 'site', 'lead', 'leads_initial_cold_outreach')).toMatchObject({ lead, channels: ['email'], recipients: { email: { recipient: 'trusted@example.com' } } });
  expect(filters).toContainEqual(['leads', 'id', 'lead']); expect(filters).toContainEqual(['leads', 'site_id', 'site']);
  (outreachRepository.history as jest.Mock).mockResolvedValue([{ id: 'inbound', role: 'user', created_at: '2026-01-01T12:00:00Z' }]);
  await expect(assertOutreachGeneration(request, 'site', 'lead', 'leads_initial_cold_outreach')).rejects.toMatchObject({ code: 'OUTREACH_NOT_ELIGIBLE', message: 'Outreach audience mismatch' });
});