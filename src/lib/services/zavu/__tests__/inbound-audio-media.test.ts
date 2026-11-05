import { randomBytes } from 'node:crypto';
import { resolveInboundAudioMedia } from '../inbound-audio-media';
import { zavuFetch } from '../client';
jest.mock('../client', () => ({ zavuFetch: jest.fn() }));
const fetchMessage = zavuFetch as jest.Mock;
const data = { messageId: 'msg_1', from: '+15555550100', to: 'bot', channel: 'whatsapp', messageType: 'audio', content: { mediaId: 'media_1' } };
const url = 'https://media.example.test/recording.ogg';
const message = { ...data, id: data.messageId, senderId: 'snd_1', direction: 'inbound', content: { mediaUrl: url } };

beforeEach(() => { jest.resetAllMocks(); jest.useFakeTimers(); });
afterEach(() => jest.useRealTimers());
async function resolve(input = data) {
  const pending = resolveInboundAudioMedia(input, 'snd_1');
  await jest.runAllTimersAsync();
  return pending;
}

test('uses documented envelope and authenticated client with bounded abort signal', async () => {
  fetchMessage.mockResolvedValue({ message });
  expect(await resolve()).toEqual({ attachments: [expect.objectContaining({ url, type: 'audio' })], audioUnavailable: false });
  expect(fetchMessage).toHaveBeenCalledWith('/messages/msg_1', expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal), redirect: 'error' }));
  expect(fetchMessage).toHaveBeenCalledTimes(1);
});
test('retries media processing once', async () => {
  fetchMessage.mockResolvedValueOnce({ message: { ...message, content: data.content } }).mockResolvedValueOnce({ message });
  expect((await resolve()).audioUnavailable).toBe(false);
  expect(fetchMessage).toHaveBeenCalledTimes(2);
});
test.each(['id', 'senderId', 'from', 'channel', 'direction', 'messageType', 'to'])('rejects mismatched or missing %s', async field => {
  for (const value of ['wrong', undefined]) {
    fetchMessage.mockResolvedValue({ message: { ...message, [field]: value } });
    expect((await resolve()).audioUnavailable).toBe(true);
  }
  expect(fetchMessage).toHaveBeenCalledTimes(2);
});
test('rejects undocumented envelope', async () => {
  fetchMessage.mockResolvedValue(message);
  expect((await resolve()).audioUnavailable).toBe(true);
});
test('skips lookup for existing URLs and non-audio', async () => {
  await resolve({ ...data, content: { mediaUrl: url } } as any);
  await resolve({ ...data, messageType: 'image' });
  await resolve({ ...data, mediaUrl: url } as any);
  expect(fetchMessage).not.toHaveBeenCalled();
});
test('never looks up an event ID or unsafe message ID', async () => {
  for (const messageId of [undefined, '', '../secret', 'a?b']) {
    expect((await resolve({ ...data, messageId } as any)).audioUnavailable).toBe(true);
  }
  expect(fetchMessage).not.toHaveBeenCalled();
});
test('bounds stalled requests to two short attempts and aborts both', async () => {
  fetchMessage.mockImplementation(() => new Promise(() => {}));
  expect((await resolve()).audioUnavailable).toBe(true);
  expect(fetchMessage).toHaveBeenCalledTimes(2);
  for (const [, init] of fetchMessage.mock.calls) expect(init.signal.aborted).toBe(true);
});
test('does not expose provider errors or credentials', async () => {
  const secret = randomBytes(24).toString('hex');
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  fetchMessage.mockRejectedValue(new Error(secret));
  const result = await resolve();
  expect(result.audioUnavailable).toBe(true);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  expect(fetchMessage).toHaveBeenCalledTimes(2);
  log.mockRestore();
});
test.each(['javascript:alert(1)', 'not a URL'])('rejects invalid media URL %s', async mediaUrl => {
  fetchMessage.mockResolvedValue({ message: { ...message, content: { mediaUrl } } });
  expect((await resolve()).audioUnavailable).toBe(true);
});
