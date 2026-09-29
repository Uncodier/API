jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/database/task-db', () => ({ createTask: jest.fn() }));
jest.mock('@/lib/helpers/lead-context-helper', () => ({ getLeadInfo: jest.fn(), safeStringify: JSON.stringify }));
jest.mock('@/lib/services/conversation-service', () => ({ ConversationService: {} }));
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getSiteChannelsConfiguration } from '../../lead-followup/helpers/LeadFollowUpChannelHelper';
import { LeadFollowUpLogService } from '../../lead-followup/LeadFollowUpLogService';
import { extractFinalContent } from '../../lead-followup/helpers/LeadFollowUpContentHelper';
import { filterAndCorrectMessageChannel } from '../../lead-followup/helpers/LeadFollowUpChannelHelper';
const activity = 'leads_initial_cold_outreach';

test('generation works for Zavu-only selected email and excludes all unselected channels', async () => {
  const settings = { channels: { whatsapp: { status: 'active' }, connections: [{ id: 'hi', type: 'email', status: 'connected', zavu_sender_id: 'sender' }] }, activities: { [activity]: { status: 'active', channel_accounts: { email: ['hi'], whatsapp: [] } } } };
  const query: any = { select: () => query, eq: () => query, single: async () => ({ data: settings }) };
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  expect(await getSiteChannelsConfiguration('site', activity)).toMatchObject({ hasChannels: true, configuredChannels: ['email'], channelsDetails: { email: { account_ids: ['hi'] } } });
  settings.activities[activity].channel_accounts.email = [];
  expect(await getSiteChannelsConfiguration('site', activity)).toMatchObject({ hasChannels: false, configuredChannels: [] });
});
test('generated log persists trusted outreach_activity overriding model supplied provenance', async () => {
  const service = new LeadFollowUpLogService();
  jest.spyOn(service, 'getOrCreateChannelConversation').mockResolvedValue('conversation');
  const insert = jest.fn();
  const query: any = { insert: (value: any) => { insert(value); return query; }, select: () => query, single: async () => ({ data: { id: 'new-message' } }) };
  (supabaseAdmin.from as jest.Mock).mockReturnValue(query);
  await service.createChannelMessages({ siteId: 'site', leadId: 'lead', leadData: { id: 'lead' }, userId: 'user', outreachActivity: activity,
    messages: { telegram: { title: 'Hi', message: 'Hello', message_type: 'audio', media_url: 'https://cdn.example.com/audio.mp3', custom_data: { outreach_activity: 'leads_follow_up', outreach_delivery: { state: 'sent' } } } } });
  expect(insert.mock.calls[0][0][0].custom_data).toMatchObject({ outreach_activity: activity, status: 'pending', channel: 'telegram', message_type: 'audio', media_url: 'https://cdn.example.com/audio.mp3' });
  expect(insert.mock.calls[0][0][0].custom_data.outreach_delivery).toBeUndefined();
});
test('managed invalid channels never corrected to an available email', () => {
  const item = { channel: 'telegram', title: 'Hi', message: 'Hello' };
  expect(extractFinalContent({ results: [{ follow_up_content: item }] }, false, item, 'test', ['email'], true)).toEqual([]);
  expect(filterAndCorrectMessageChannel({ telegram: item }, ['email'], { recipients: { email: { channel: 'email', recipient: 'user@example.com', source: 'lead_email' } } }).correctedMessages).toEqual({});
});