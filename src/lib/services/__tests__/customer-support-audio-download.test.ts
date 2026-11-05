import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { request } from 'node:https';
import { downloadDocument } from '@/app/api/agents/tools/read_document/source';
import { downloadSupportAudio } from '../customer-support-audio-download';
jest.mock('node:https', () => ({ request: jest.fn() }));
jest.mock('@/app/api/agents/tools/read_document/source', () => ({ downloadDocument: jest.fn() }));
const siteId = randomUUID();
const auth = { siteId, accountSid: `AC${randomBytes(16).toString('hex')}`, authToken: randomBytes(24).toString('hex') };
const url = new URL(`https://api.twilio.com/2010-04-01/Accounts/${auth.accountSid}/Messages/SM${randomBytes(16).toString('hex')}/Media/ME${randomBytes(16).toString('hex')}`);
beforeEach(() => {
  jest.clearAllMocks();
  (downloadDocument as jest.Mock).mockResolvedValue({ buffer: Buffer.from('audio'), mimeType: 'audio/ogg' });
});
test('ordinary URLs use the existing hardened downloader without credentials', async () => {
  const publicUrl = new URL('https://media.example.test/audio.ogg');
  await downloadSupportAudio(publicUrl, siteId, auth);
  expect(downloadDocument).toHaveBeenCalledWith(publicUrl.href);
  expect(request).not.toHaveBeenCalled();
});
test('Twilio requires explicit matching site/account and TLS, never env fallback', async () => {
  for (const [target, credentials] of [
    [url, undefined], [url, { ...auth, siteId: randomUUID() }],
    [url, { ...auth, accountSid: `AC${randomBytes(16).toString('hex')}` }],
    [new URL(url.href.replace('https:', 'http:')), auth],
  ] as const) await expect(downloadSupportAudio(target, siteId, credentials)).rejects.toThrow('authentication unavailable');
  expect(request).not.toHaveBeenCalled();
});
test('authenticated redirect delegates to SSRF downloader without auth headers', async () => {
  (request as jest.Mock).mockImplementation((_url, _options, callback) => {
    const req = new EventEmitter() as any;
    req.end = () => {
      const response = Readable.from([]) as any;
      response.statusCode = 307; response.headers = { location: 'https://cdn.example.test/audio.ogg' };
      callback(response);
    };
    return req;
  });
  await downloadSupportAudio(url, siteId, auth);
  expect(downloadDocument).toHaveBeenCalledWith('https://cdn.example.test/audio.ogg');
  expect((request as jest.Mock).mock.calls[0][1].headers.authorization).toBe(`Basic ${Buffer.from(`${auth.accountSid}:${auth.authToken}`).toString('base64')}`);
});
test('oversized authenticated response is rejected without exposing credentials', async () => {
  (request as jest.Mock).mockImplementation((_url, _options, callback) => {
    const req = new EventEmitter() as any;
    req.end = () => {
      const response = Readable.from([]) as any;
      response.statusCode = 200; response.headers = { 'content-length': String(21 * 1024 * 1024) };
      callback(response);
    };
    return req;
  });
  await expect(downloadSupportAudio(url, siteId, auth)).rejects.toThrow('Audio download unavailable');
  expect(downloadDocument).not.toHaveBeenCalled();
});
