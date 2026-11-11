jest.mock('@/lib/services/channels/ChannelSendService', () => ({ ChannelSendService: { sendMessage: jest.fn() } }));
import { ChannelSendService } from '@/lib/services/channels/ChannelSendService';
import { sendChannelMessageTool } from '../assistantProtocol';

beforeEach(() => jest.clearAllMocks());
test('exposes canonical media and text/audio response modes, forwarding without link downgrade', async () => {
  const tool = sendChannelMessageTool('trusted-site');
  expect(tool.parameters.properties.message_type.enum).toEqual(['text', 'image', 'video', 'audio', 'document']);
  expect(tool.parameters.properties.response_format.enum).toEqual(['text', 'audio']);
  jest.mocked(ChannelSendService.sendMessage).mockResolvedValue({ success: true, messageId: 'provider' });
  const args = { channel: 'telegram', to: '123', message: '', message_type: 'document' as const,
    media_url: 'https://assets.example.test/file.pdf', mime_type: 'application/pdf' };
  await tool.execute(args);
  expect(ChannelSendService.sendMessage).toHaveBeenCalledWith({ ...args, site_id: 'trusted-site' });
});
test('preserves skipped delivery and surfaces explicit provider rejection', async () => {
  jest.mocked(ChannelSendService.sendMessage).mockResolvedValue({ success: true, skipped: true });
  const tool = sendChannelMessageTool('site');
  expect(await tool.execute({ channel: 'telegram', to: '123', message: 'hello' })).toMatchObject({ skipped: true });
  jest.mocked(ChannelSendService.sendMessage).mockResolvedValue({ success: false, error: 'unsupported media' });
  await expect(tool.execute({ channel: 'sms', to: '123', message: '', message_type: 'video',
    media_url: 'https://assets.example.test/video.mp4' })).rejects.toThrow('unsupported media');
});