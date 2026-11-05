import { randomUUID, randomBytes } from 'node:crypto';
import { supportAudioContext, SUPPORT_AUDIO_LIMITS } from '../customer-support-audio';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CreditService } from '../billing/CreditService';
import { transcribeAudioBuffer } from '../ai/transcribeAudio';
import { downloadSupportAudio } from '../customer-support-audio-download';
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('../billing/CreditService', () => ({ CreditService: { PRICING: { AUDIO_TRANSCRIPTION: 1 }, validateCredits: jest.fn(), deductCredits: jest.fn() } }));
jest.mock('../ai/transcribeAudio', () => ({ transcribeAudioBuffer: jest.fn(), normalizeAudioMimeType: (v: string) => v }));
jest.mock('../customer-support-audio-download', () => ({ SUPPORT_AUDIO_MAX_BYTES: 20 * 1024 * 1024, downloadSupportAudio: jest.fn() }));
const siteId = randomUUID();
const attachment = { url: 'https://media.example.test/note.ogg', mimeType: 'audio/ogg' };
const rows = new Map<string, any>();
let dbError = false;
beforeEach(() => {
  jest.clearAllMocks(); rows.clear(); dbError = false;
  (supabaseAdmin.from as jest.Mock).mockImplementation(() => {
    let op: string, value: any;
    const filters: Record<string, string> = {};
    const query: any = {
      insert(v: any) { op = 'insert'; value = v; return query; },
      update(v: any) { op = 'update'; value = v; return query; },
      select() { op = 'select'; return query; },
      eq(k: string, v: string) { filters[k] = v; return query; },
      maybeSingle() { return query; },
      then(resolve: any, reject: any) {
        if (dbError) return Promise.resolve({ error: { code: 'unavailable' } }).then(resolve, reject);
        const key = op === 'insert' ? `${value.site_id}:${value.source_hash}` : `${filters.site_id}:${filters.source_hash}`;
        let result: any = { error: null };
        if (op === 'insert') {
          if (rows.has(key)) result = { error: { code: '23505' } };
          else rows.set(key, { ...value });
        } else if (op === 'select') result.data = rows.get(key);
        else rows.set(key, { ...rows.get(key), ...value });
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return query;
  });
  (CreditService.validateCredits as jest.Mock).mockResolvedValue(true);
  (CreditService.deductCredits as jest.Mock).mockResolvedValue({ success: true });
  (downloadSupportAudio as jest.Mock).mockResolvedValue({ buffer: Buffer.from('audio'), mimeType: 'audio/ogg' });
  (transcribeAudioBuffer as jest.Mock).mockResolvedValue({ success: true, text: 'Please help me.' });
});
afterEach(() => jest.useRealTimers());
const run = (attachments = [attachment]) => supportAudioContext({ siteId, attachments });
test('historical replay avoids repeat download and billing', async () => {
  const first = await run();
  expect(first).toContain('Please help me.');
  expect(first).toContain('untrusted customer data');
  expect(await supportAudioContext({ siteId, attachments: [attachment], messageId: randomUUID() })).toBe(first);
  expect(downloadSupportAudio).toHaveBeenCalledTimes(1);
  expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([...rows.values()])).not.toContain(attachment.url);
});
test('concurrent and cross-site admission', async () => {
  await Promise.all([run(), run()]);
  expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
  await supportAudioContext({ siteId: randomUUID(), attachments: [attachment] });
  expect(CreditService.deductCredits).toHaveBeenCalledTimes(2);
});
test('fails closed without persistence', async () => {
  dbError = true;
  expect(await run()).toContain('unavailable');
  expect(downloadSupportAudio).not.toHaveBeenCalled();
});
test('provider failures are sanitized and never rebilled', async () => {
  const secret = randomBytes(24).toString('hex');
  (transcribeAudioBuffer as jest.Mock).mockRejectedValue(new Error(secret));
  const result = await run();
  expect(result).toContain('unavailable'); expect(result).not.toContain(secret);
  expect(await run()).toContain('unavailable');
  expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
});
test('credit failures prevent provider invocation', async () => {
  (CreditService.validateCredits as jest.Mock).mockResolvedValue(false);
  await run(); expect(downloadSupportAudio).not.toHaveBeenCalled();
  rows.clear(); (CreditService.validateCredits as jest.Mock).mockResolvedValue(true);
  (CreditService.deductCredits as jest.Mock).mockResolvedValue({ success: false });
  expect(await run()).toContain('unavailable');
  expect(transcribeAudioBuffer).not.toHaveBeenCalled();
});
test.each(['text/html', 'audio/unsupported'])('rejects MIME %s before billing', async mimeType => {
  (downloadSupportAudio as jest.Mock).mockResolvedValue({ buffer: Buffer.from('audio'), mimeType });
  expect(await run()).toContain('unavailable');
  expect(CreditService.deductCredits).not.toHaveBeenCalled();
});
test('bounds count and deduplicates', async () => {
  const result = await run([attachment, attachment, { ...attachment, url: 'https://example.test/2.ogg' }, { ...attachment, url: 'https://example.test/3.ogg' }]);
  expect(result).toContain('limit reached');
  expect(downloadSupportAudio).toHaveBeenCalledTimes(2);
});
test('deadline leaves durable claim and never continues billing', async () => {
  jest.useFakeTimers();
  (downloadSupportAudio as jest.Mock).mockImplementation(() => new Promise(() => {}));
  const result = run();
  await jest.advanceTimersByTimeAsync(SUPPORT_AUDIO_LIMITS.timeMs + 1);
  expect(await result).toContain('unavailable');
  expect(CreditService.deductCredits).not.toHaveBeenCalled();
  expect(await run()).toContain('unavailable');
  expect(downloadSupportAudio).toHaveBeenCalledTimes(1);
});

test('rejects empty and oversized bytes before billing', async () => {
  for (const size of [0, SUPPORT_AUDIO_LIMITS.bytes + 1]) {
    rows.clear();
    (downloadSupportAudio as jest.Mock).mockResolvedValue({ buffer: Buffer.alloc(size), mimeType: 'audio/ogg' });
    expect(await run()).toContain('unavailable');
  }
  expect(CreditService.deductCredits).not.toHaveBeenCalled();
});
test('URL credentials are rejected and never echoed', async () => {
  const url = new URL('https://media.example.test/audio.ogg');
  url.username = randomBytes(12).toString('hex');
  url.password = randomBytes(24).toString('hex');
  const result = await run([{ ...attachment, url: url.href }]);
  expect(result).toContain('unavailable');
  expect(result).not.toContain(url.username);
  expect(result).not.toContain(url.password);
  expect(downloadSupportAudio).not.toHaveBeenCalled();
});
test('caps transcripts and ignores documents', async () => {
  expect(await run([{ url: 'https://example.test/file.pdf', mimeType: 'application/pdf' }])).toBe('');
  (transcribeAudioBuffer as jest.Mock).mockResolvedValue({ success: true, text: 'a'.repeat(20000) });
  await run();
  expect([...rows.values()][0].transcript.length).toBe(SUPPORT_AUDIO_LIMITS.transcriptChars);
});
