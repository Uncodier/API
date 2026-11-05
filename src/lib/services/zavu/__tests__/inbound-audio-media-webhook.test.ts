import { handleInboundMessage } from '../webhook-handlers';
import { supabaseAdmin } from '@/lib/database/supabase-server';
import { admitZavuInboundAutomation } from '../inbound-message-license';
import { resolveInboundAudioMedia } from '../inbound-audio-media';
import { WorkflowService } from '@/lib/services/workflow-service';
jest.mock('../invitation-finalization', () => ({}));
jest.mock('../domain-status', () => ({}));
jest.mock('../voice-webhook-handler', () => ({}));
jest.mock('@/lib/database/supabase-server', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/lib/security/upstash-rest', () => ({ sha256: async (s: string) => s, setCachedJson: jest.fn() }));
jest.mock('../inbound-message-license', () => ({ admitZavuInboundAutomation: jest.fn() }));
jest.mock('../inbound-audio-media', () => ({ resolveInboundAudioMedia: jest.fn() }));
jest.mock('@/lib/services/workflow-service', () => ({ WorkflowService: { getInstance: jest.fn() } }));
const connection = { id: 'conn_1', type: 'whatsapp', zavu_sender_id: 'snd_1' };
const site = { site_id: 'site_1', channels: { connections: [connection] } };
const event = { senderId: 'snd_1', data: { from: '+15555550100', channel: 'whatsapp', messageType: 'audio', messageId: 'msg_1' } };
const workflow = jest.fn();
function settings(rows: any[]) {
  (supabaseAdmin.from as jest.Mock).mockImplementation(table => table === 'settings'
    ? { select: () => ({ contains: async () => ({ data: rows }) }) }
    : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: 'user_1' } }) }) }) });
}
beforeEach(() => {
  jest.clearAllMocks(); settings([site]);
  (admitZavuInboundAutomation as jest.Mock).mockResolvedValue(true);
  (resolveInboundAudioMedia as jest.Mock).mockResolvedValue({ attachments: [], audioUnavailable: true });
  (WorkflowService.getInstance as jest.Mock).mockReturnValue({ customerSupportMessage: workflow });
  workflow.mockResolvedValue({ success: true });
});
test.each([[], [site, site], [{ ...site, channels: { connections: [connection, connection] } }]].map(rows => ({ rows })))('does not look up media with nonunique binding', async ({ rows }) => {
  settings(rows);
  await handleInboundMessage(event);
  expect(resolveInboundAudioMedia).not.toHaveBeenCalled();
});
test('denied admission performs no lookup', async () => {
  (admitZavuInboundAutomation as jest.Mock).mockResolvedValue(false);
  await handleInboundMessage(event);
  expect(resolveInboundAudioMedia).not.toHaveBeenCalled();
});
test('lookup follows admission and missing audio is explicit in workflow text', async () => {
  await handleInboundMessage(event);
  expect((admitZavuInboundAutomation as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((resolveInboundAudioMedia as jest.Mock).mock.invocationCallOrder[0]);
  expect(workflow.mock.calls[0][0].message).toContain('Audio unavailable');
});
test('passes resolved normalized attachments without changing text', async () => {
  const attachments = [{ url: 'https://media.example.test/audio.ogg', type: 'audio' }];
  (resolveInboundAudioMedia as jest.Mock).mockResolvedValue({ attachments, audioUnavailable: false });
  await handleInboundMessage(event);
  expect(workflow.mock.calls[0][0]).toMatchObject({ message: '[audio]', custom_data: { attachments } });
});
