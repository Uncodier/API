import { sendWhatsAppTool } from '../assistantProtocol';
import { WhatsAppSendService } from '@/lib/services/whatsapp/WhatsAppSendService';

jest.mock('@/lib/services/whatsapp/WhatsAppSendService', () => ({ WhatsAppSendService: { sendMessage: jest.fn() } }));
jest.mock('@/lib/database/lead-db', () => ({ getLeadById: jest.fn() }));
jest.mock('@/lib/messaging/lead-merge-fields', () => ({ fetchSiteNameForMerge: jest.fn(),
  personalizeMergeTemplate: jest.fn(), placeholderPolicyToMergePolicy: jest.fn() }));
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(WhatsAppSendService.sendMessage).mockResolvedValue({ success: true, status: 'sent' });
});
it.each(['image', 'video', 'audio', 'document'] as const)('exposes and forwards existing %s without generation', async message_type => {
  const tool = sendWhatsAppTool('site');
  const args = { phone_number: '+15555550100', message: '', message_type,
    media_url: 'https://media.example.test/file' };
  await tool.execute(args);
  expect(WhatsAppSendService.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ site_id: 'site', ...args }));
  expect(tool.parameters.properties.message_type.enum).toContain(message_type);
});
it('returns template_required honestly instead of claiming media was delivered', async () => {
  jest.mocked(WhatsAppSendService.sendMessage).mockResolvedValue({ success: true, template_required: true, status: 'template_required' });
  expect(await sendWhatsAppTool('site').execute({ phone_number: '+15555550100', message: 'Photo',
    media_urls: ['https://media.example.test/file'] })).toMatchObject({ template_required: true, status: 'template_required' });
});