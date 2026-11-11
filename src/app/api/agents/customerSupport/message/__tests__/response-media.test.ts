import { extractSupportResults } from '../results';
import { resolveSupportResults } from '../resolve-results';
import { validateSupportResponseMedia } from '../response-media';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';

jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn(async () => undefined) }));
const media = { message_type: 'image', media_url: 'https://media.example.test/image.png', mime_type: 'image/png' };

beforeEach(() => jest.clearAllMocks());

it.each(['image', 'video', 'audio', 'document'])('keeps selected existing %s separate from speech format', async message_type => {
  const selected = { ...media, message_type, mime_type: message_type === 'document' ? 'application/pdf' : `${message_type}/test` };
  const result = extractSupportResults({ results: [{ message: { content: 'Caption', response_format: 'text', ...selected } }] });
  expect(result).toMatchObject({ assistantMessage: 'Caption', responseFormat: 'text', responseMedia: selected });
  expect(await validateSupportResponseMedia(result.responseMedia, 'whatsapp', 'text')).toEqual(selected);
  expect(assertSafeRemoteUrl).toHaveBeenCalledWith(selected.media_url);
});

it.each([
  { message: { content: '', ...media } },
  { type: 'message', content: { message: { content: '', ...media } } },
  { type: 'message', content: { content: '', ...media } },
  { type: 'message', content: '', ...media },
])('accepts a media-only selected message without recovery %#', async row => {
  const read = jest.fn();
  const result = await resolveSupportResults({ results: [row] }, read);
  expect(result).toMatchObject({ assistantMessage: '', responseMedia: media });
  expect(read).not.toHaveBeenCalled();
});

it('never borrows media from tools, conversations or discarded messages', () => {
  const result = extractSupportResults({ results: [
    { type: 'tool', content: 'Tool', ...media },
    { message: { content: 'No response generated', ...media } },
    { message: { content: 'Real text' } },
    { conversation: { title: 'Title', ...media } },
  ] });
  expect(result.assistantMessage).toBe('Real text');
  expect(result.responseMedia).toBeUndefined();
});

it('takes media atomically from the innermost selected target', () => {
  const result = extractSupportResults({ results: [{ type: 'message', media_url: media.media_url,
    content: { message: { content: 'Reply', message_type: 'image' } } }] });
  expect(result.responseMedia).toEqual({ message_type: 'image' });
});

it('accepts blank plain-text model target defaults', async () => {
  expect(await validateSupportResponseMedia({ message_type: 'text', media_url: '', mime_type: '' }, 'chat', 'text')).toBeUndefined();
  expect(assertSafeRemoteUrl).not.toHaveBeenCalled();
});

it.each([
  [{ ...media }, 'whatsapp', 'audio'],
  [{ message_type: 'image' }, 'whatsapp', 'text'],
  [{ ...media, media_url: 'http://media.example.test/image.png' }, 'whatsapp', 'text'],
  [{ ...media, mime_type: 'audio/mpeg' }, 'whatsapp', 'text'],
  [{ ...media }, 'sms', 'text'],
] as const)('rejects invalid or conflicting existing media %#', async (input, channel, format) => {
  await expect(validateSupportResponseMedia(input, channel, format)).rejects.toThrow();
  expect(assertSafeRemoteUrl).not.toHaveBeenCalled();
});

it('rejects a URL failing public DNS validation', async () => {
  jest.mocked(assertSafeRemoteUrl).mockRejectedValueOnce(new Error('private'));
  await expect(validateSupportResponseMedia(media, 'whatsapp', 'text')).rejects.toThrow('public HTTPS');
});

it('rejects public comment media instead of silently persisting text', async () => {
  await expect(validateSupportResponseMedia(media, 'instagram', 'text', true)).rejects.toThrow('COMMENT_MEDIA_UNSUPPORTED');
});