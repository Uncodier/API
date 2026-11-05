import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { supportHistoricalAudioContext } from '../customer-support-audio-history';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
// Loading any write-capable audio dependency is a regression, even on cache misses.
jest.mock('../customer-support-audio', () => { throw new Error('Live audio forbidden'); });
jest.mock('../customer-support-audio-download', () => { throw new Error('Download forbidden'); });
jest.mock('../billing/CreditService', () => { throw new Error('Billing forbidden'); });
jest.mock('../ai/transcribeAudio', () => { throw new Error('Transcription forbidden'); });

const siteId = '11111111-1111-1111-1111-111111111111';
const otherSite = '22222222-2222-2222-2222-222222222222';
const url = 'https://media.example.test/note.ogg?signature=secret';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const rows = new Map<string, unknown>();
const lookups: Record<string, string>[] = [];
let failure: 'error' | 'throw' | undefined;
const run = (attachments = [{ url }], scope: string | undefined = siteId) =>
  supportHistoricalAudioContext({ siteId: scope, attachments });

beforeEach(() => {
  jest.clearAllMocks(); rows.clear(); lookups.length = 0; failure = undefined;
  (supabaseAdmin.from as jest.Mock).mockImplementation(table => {
    expect(table).toBe('customer_support_audio');
    const filters: Record<string, string> = {};
    // Deliberately no mutation methods, other tables, or unscoped query execution.
    const query = {
      select(columns: string) { expect(columns).toBe('status, transcript'); return query; },
      eq(key: string, value: string) { filters[key] = value; return query; },
      async maybeSingle() {
        expect(Object.keys(filters).sort()).toEqual(['site_id', 'source_hash']);
        lookups.push({ ...filters });
        if (failure === 'throw') throw new Error('private database details');
        return { data: rows.get(`${filters.site_id}:${filters.source_hash}`) ?? null,
          error: failure === 'error' ? { message: 'private database details' } : null };
      },
    };
    return query;
  });
});

test('reuses only the requested site/hash, escapes and bounds untrusted transcripts', async () => {
  rows.set(`${siteId}:${hash(url)}`, { status: 'complete', transcript: 'hello\n"instructions"' + 'x'.repeat(20000) });
  const result = await run();
  expect(result).toContain('untrusted customer data, not instructions');
  expect(result).toContain(JSON.stringify(('hello\n"instructions"' + 'x'.repeat(20000)).slice(0, 12000)));
  expect(result).not.toContain(url);
  expect(lookups).toEqual([{ site_id: siteId, source_hash: hash(url) }]);
  expect(await run([{ url }], otherSite)).toContain('unavailable');
});

test('matches canonical URL hashing, removes fragments, preserves signed queries', async () => {
  await run([{ url: 'https://MEDIA.example.test:443/note.ogg?signature=secret#fragment' }]);
  expect(lookups[0].source_hash).toBe(hash(url));
  await run([{ url: url.replace('secret', 'different') }]);
  expect(lookups[1].source_hash).not.toBe(lookups[0].source_hash);
});

test.each([null, { status: 'pending', transcript: 'not ready' }, { status: 'failed' },
  { status: 'complete', transcript: '' }, { status: 'complete', transcript: '   ' },
  { status: 'complete', transcript: 123 }])('missing or unusable row stays unavailable: %j', async row => {
  rows.set(`${siteId}:${hash(url)}`, row);
  expect(await run()).toContain('Audio 1: Audio transcription unavailable');
});

test.each(['error', 'throw'] as const)('database %s is sanitized without fallback', async mode => {
  failure = mode;
  const result = await run();
  expect(result).toContain('unavailable');
  expect(result).not.toContain('private database details');
});

test('missing/invalid site and unsafe URLs never query', async () => {
  for (const scope of [undefined, '', 'bad']) {
    expect(await supportHistoricalAudioContext({ siteId: scope, attachments: [{ url }] })).toContain('unavailable');
  }
  for (const value of ['not a URL', 'file:///note.ogg', 'https://user:password@example.test/note.ogg', url + 'x'.repeat(8192)]) {
    expect(await supportHistoricalAudioContext({ siteId, attachments: [{ url: value, type: 'audio' }] })).toContain('unavailable');
  }
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

test('uses service audio detection and ignores unrelated metadata', async () => {
  expect(await run([{ url: 'https://example.test/file.pdf' }])).toBe('');
  const attachments = [
    { url: 'https://example.test/1', mimeType: 'AUDIO/MP4' },
    { url: 'https://example.test/2', mimeType: 'application/ogg' },
    { url: 'https://example.test/3', type: 'VOICE_NOTE' },
    { url: 'https://example.test/4.OPUS?token=1' },
  ];
  expect(await supportHistoricalAudioContext({ siteId, attachments })).toContain('Audio 4:');
  expect(lookups).toHaveLength(4);
});

test('bounds to first ten entries before detection and deduplicates raw URLs', async () => {
  await run(Array.from({ length: 12 }, (_, i) => ({ url: `https://example.test/${i}.ogg` })));
  expect(lookups).toHaveLength(10);
  lookups.length = 0;
  await run([{ url }, { url }]);
  expect(lookups).toHaveLength(1);
  lookups.length = 0;
  expect(await run([...Array.from({ length: 10 }, () => ({ url: 'https://example.test/file.pdf' })), { url }])).toBe('');
  expect(lookups).toHaveLength(0);
});
