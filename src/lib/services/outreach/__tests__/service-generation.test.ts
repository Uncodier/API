jest.mock('@/lib/agentbase', () => ({ CommandFactory: { createCommand: jest.fn((value: any) => value) } }));
jest.mock('../generation-guard', () => ({ assertOutreachGeneration: jest.fn() }));
jest.mock('@/lib/helpers/lead-context-helper', () => ({ getLeadInfo: jest.fn(), getPreviousInteractions: jest.fn(async () => []), buildEnrichedContext: jest.fn(async () => ''), safeStringify: JSON.stringify }));
jest.mock('@/lib/services/lead-followup/LeadFollowUpHelper', () => ({
  parseIncomingRequest: jest.fn(), isValidUUID: () => true, isValidPhoneNumber: () => true,
  findActiveSalesAgent: jest.fn(), findActiveCopywriter: jest.fn(async () => null), getSiteChannelsConfiguration: jest.fn(),
  triggerChannelsSetupNotification: jest.fn(), getAgentInfo: jest.fn(),
  filterAndCorrectMessageChannel: jest.requireActual('../../lead-followup/helpers/LeadFollowUpChannelHelper').filterAndCorrectMessageChannel,
  waitForCommandCompletion: jest.fn(), executeCopywriterRefinement: jest.fn(), commandService: { submitCommand: jest.fn(async () => 'command') },
}));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
import { CommandFactory } from '@/lib/agentbase';
import { assertOutreachGeneration } from '../generation-guard';
import { availableOutreachRecipients } from '../recipients';
import { LeadFollowUpService } from '../../lead-followup/LeadFollowUpService';
import { parseIncomingRequest, getSiteChannelsConfiguration, waitForCommandCompletion } from '../../lead-followup/LeadFollowUpHelper';
const siteId = '11111111-1111-4111-8111-111111111111';
const leadId = '22222222-2222-4222-8222-222222222222';
beforeEach(() => jest.clearAllMocks());
test.each(['sms', 'telegram', 'voice', 'instagram', 'custom_chat'])('real managed %s-only generation retains channel/schema without email fallback', async channel => {
  const lead = { id: leadId, site_id: siteId, status: 'new', phone: ['sms', 'voice'].includes(channel) ? '+15551234567' : null,
    social_networks: { [channel]: 'chat-user' }, voice_call_consent_status: 'granted', voice_call_consent_at: '2026-01-01T12:00:00Z' };
  const recipients = availableOutreachRecipients({ siteId, lead, channels: [channel] });
  (assertOutreachGeneration as jest.Mock).mockResolvedValue({ lead, channels: Object.keys(recipients), recipients });
  (parseIncomingRequest as jest.Mock).mockResolvedValue({ body: { siteId, leadId, userId: 'user', outreach_activity: 'leads_initial_cold_outreach' }, files: {} });
  (getSiteChannelsConfiguration as jest.Mock).mockResolvedValue({ hasChannels: true, configuredChannels: [channel], channelsDetails: {} });
  (waitForCommandCompletion as jest.Mock).mockResolvedValue({ completed: true, command: { status: 'completed', results: [{ follow_up_content: {
    channel, title: 'Hello', message: 'Hello from your team', ...(channel === 'telegram' ? { message_type: 'audio', media_url: 'https://cdn.example.com/reply.mp3' } : {}),
  } }] } });
  const result = await new LeadFollowUpService().processRequest(new Request('http://localhost'), 'test');
  expect(Object.keys(result.messages)).toEqual([channel]);
  expect(result.messages[channel]).toMatchObject({ channel, message: 'Hello from your team', custom_data: { outreach_activity: 'leads_initial_cold_outreach' } });
  if (channel === 'telegram') expect(result.messages[channel]).toMatchObject({ message_type: 'audio', media_url: 'https://cdn.example.com/reply.mp3' });
  expect((CommandFactory.createCommand as jest.Mock).mock.calls[0][0].targets[1].follow_up_content.channel).toContain(channel);
});