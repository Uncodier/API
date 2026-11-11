import { downloadDocument } from '@/app/api/agents/tools/read_document/source';
import { resolveEmailMediaAttachment } from '../email-media';
jest.mock('@/app/api/agents/tools/read_document/source', () => ({ downloadDocument: jest.fn() }));
beforeEach(() => jest.clearAllMocks());

it.each(['image', 'video', 'audio', 'document'] as const)('turns an existing %s into email attachment bytes', async messageType => {
  const mimeType = messageType === 'document' ? 'application/pdf' : `${messageType}/example`;
  const buffer = Buffer.from('synthetic file bytes');
  jest.mocked(downloadDocument).mockResolvedValue({ buffer, filename: '../file\r\n.bin', mimeType });
  const content = { mediaUrl: 'https://media.example.test/file', mimeType };
  expect(await resolveEmailMediaAttachment({ messageType, content })).toEqual({ filename: '.._file__.bin',
    content: buffer.toString('base64'), content_type: mimeType });
  expect(downloadDocument).toHaveBeenCalledWith(content.mediaUrl, { httpsOnly: true });
});
it('fails before sending if the download fails', async () => {
  jest.mocked(downloadDocument).mockRejectedValue(new Error('Private network'));
  await expect(resolveEmailMediaAttachment({ messageType: 'image', content: { mediaUrl: 'https://media.example.test/file' } })).rejects.toThrow('Private network');
});
it.each([
  { buffer: Buffer.alloc(0), mimeType: 'image/png' },
  { buffer: Buffer.alloc(20 * 1024 * 1024 + 1), mimeType: 'image/png' },
  { buffer: Buffer.from('synthetic'), mimeType: 'text/html' },
])('rejects invalid downloaded images', async loaded => {
  jest.mocked(downloadDocument).mockResolvedValue({ ...loaded, filename: 'file' });
  await expect(resolveEmailMediaAttachment({ messageType: 'image', content: { mediaUrl: 'https://media.example.test/file', mimeType: 'image/png' } })).rejects.toMatchObject({ status: 400 });
});