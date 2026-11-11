import { randomBytes } from 'node:crypto';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { validateOutboundMedia, validateWhatsAppMedia } from '../outbound-media';

jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn(async (url: string) => new URL(url)) }));
const media_url = 'https://media.example.test/existing-file';
beforeEach(() => jest.clearAllMocks());

it.each(['whatsapp', 'telegram', 'messenger', 'custom_chat', 'email'])('preserves all explicit media types for %s', async channel => {
  for (const message_type of ['image', 'video', 'audio', 'document']) {
    expect(await validateOutboundMedia({ message_type, media_url }, channel)).toEqual({ messageType: message_type, content: { mediaUrl: media_url } });
  }
});
it.each(['sms', 'voice', 'facebook', 'threads', 'linkedin', 'x', 'twitter', 'youtube'])('does not downgrade unsupported %s to a URL', async channel => {
  await expect(validateOutboundMedia({ message_type: 'image', media_url }, channel)).rejects.toMatchObject({ status: 400 });
  expect(assertSafeRemoteUrl).not.toHaveBeenCalled();
});
it('supports Instagram image/video but not audio/documents', async () => {
  for (const message_type of ['image', 'video']) expect(await validateOutboundMedia({ message_type, media_url }, 'instagram')).toBeDefined();
  for (const message_type of ['audio', 'document']) await expect(validateOutboundMedia({ message_type, media_url }, 'instagram')).rejects.toThrow('Instagram');
});
it.each([
  { media_url }, { message_type: 'image' }, { message_type: 'text', media_url },
  { message_type: 'image', media_url, mime_type: 'video/mp4' },
  { message_type: 'image', media_url, response_format: 'audio' },
  { message_type: 'image', media_url: 'http://media.example.test/file' },
])('rejects malformed or conflicting metadata %j', async input => {
  await expect(validateOutboundMedia(input, 'whatsapp')).rejects.toMatchObject({ status: 400 });
});
it('rejects authenticated URLs with synthetic credentials', async () => {
  const url = new URL(media_url);
  url.username = randomBytes(16).toString('hex');
  url.password = randomBytes(32).toString('hex');
  await expect(validateOutboundMedia({ message_type: 'image', media_url: url.href }, 'telegram')).rejects.toThrow('without credentials');
});
it('rejects private DNS and does not download media', async () => {
  jest.mocked(assertSafeRemoteUrl).mockRejectedValueOnce(new Error('private'));
  await expect(validateOutboundMedia({ message_type: 'image', media_url }, 'whatsapp')).rejects.toMatchObject({ status: 400 });
});
it('leaves text without explicit media unchanged', async () => {
  expect(await validateOutboundMedia({}, 'sms')).toBeUndefined();
  expect(await validateOutboundMedia({ message_type: 'text' }, 'sms')).toBeUndefined();
  expect(assertSafeRemoteUrl).not.toHaveBeenCalled();
});
it('validates and copies one legacy WhatsApp attachment', async () => {
  const media_urls = [media_url];
  const validated = await validateWhatsAppMedia({ media_urls });
  expect(validated).toEqual(media_urls);
  expect(validated).not.toBe(media_urls);
  await expect(validateWhatsAppMedia({ media_urls: [media_url, media_url] })).rejects.toThrow('at most one');
  await expect(validateWhatsAppMedia({ media_urls, message_type: 'image', media_url })).rejects.toThrow('not both');
  await expect(validateWhatsAppMedia({ media_urls, response_format: 'audio' })).rejects.toThrow('generated audio');
});