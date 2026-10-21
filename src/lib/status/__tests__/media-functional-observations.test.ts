import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

// All persistence, billing and telemetry are in-memory doubles. No client may reach a database.
jest.mock('@/lib/database/supabase-client', () => {
  const forbidden = jest.fn(() => { throw new Error('Database forbidden in offline tests'); });
  return { supabaseAdmin: { from: forbidden, rpc: forbidden }, supabase: { from: forbidden, rpc: forbidden } };
});
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => { throw new Error('Database client forbidden'); }) }));
jest.mock('openai', () => ({ __esModule: true, default: jest.fn(() => { throw new Error('Provider SDK forbidden'); }) }));
jest.mock('@/lib/status/telemetry', () => ({ recordTelemetry: jest.fn(), getLatestTelemetry: jest.fn() }));
jest.mock('@/lib/security/upstash-rest', () => ({ sha256: jest.fn(), getCachedJson: jest.fn(), setCachedJson: jest.fn() }));
jest.mock('@/app/api/ai/image/image-storage', () => ({ persistGeneratedImage: jest.fn() }));
jest.mock('@/lib/security/safe-remote-url', () => ({ assertSafeRemoteUrl: jest.fn() }));
jest.mock('@/app/api/ai/video/provider-openrouter', () => ({
  submitOpenRouterVideo: jest.fn(), pollOpenRouterVideo: jest.fn(), downloadOpenRouterVideo: jest.fn(),
}));
jest.mock('@/app/api/ai/video/video-storage', () => ({ persistGeneratedVideo: jest.fn() }));
jest.mock('@/lib/services/billing/CreditService', () => ({
  CreditService: { PRICING: { VIDEO_GENERATION_MINUTE: 24 }, deductCredits: jest.fn() },
}));

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createClient } from '@supabase/supabase-js';
import { recordTelemetry, getLatestTelemetry, type TelemetryRecord } from '@/lib/status/telemetry';
import { sha256, getCachedJson, setCachedJson } from '@/lib/security/upstash-rest';
import { synthesizeSpeech } from '@/lib/services/ai/tts-service';
import { generateWithAzure } from '@/app/api/ai/image/provider-azure';
import { persistGeneratedImage } from '@/app/api/ai/image/image-storage';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { startVideoJob, resumeVideoJob } from '@/app/api/ai/video/openrouter-jobs';
import { submitOpenRouterVideo, pollOpenRouterVideo, downloadOpenRouterVideo } from '@/app/api/ai/video/provider-openrouter';
import { persistGeneratedVideo } from '@/app/api/ai/video/video-storage';
import { CreditService } from '@/lib/services/billing/CreditService';
import { MediaRequestError } from '@/lib/services/image/media-request-error';
import { aiImageHandler } from '@/lib/status/handlers/ai/image';
import { aiVideoHandler } from '@/lib/status/handlers/ai/video';
import { getImageObservationKey, getVideoObservationKey, getTtsObservationKey, AI_OBSERVATION_MAX_AGE_MS } from '@/lib/status/handlers/ai/passive-probes';

const synthetic = () => randomBytes(24).toString('hex');
const telemetry = jest.mocked(recordTelemetry);
const latest = jest.mocked(getLatestTelemetry);
const store = new Map<string, any>();
const receipts = new Map<string, TelemetryRecord>();
const imageOptions = { prompt: 'A synthetic image prompt', siteId: 'site-a', count: 1 };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64');
const imageOutput = { data: [{ b64_json: png }] };
const videoBody = { prompt: 'A synthetic video prompt', site_id: 'site-a' };
const prepared = { model: 'vendor/video-a', prompt: videoBody.prompt, duration: 8, aspect_ratio: '16:9' };
let fetchMock: jest.SpiedFunction<typeof fetch>;
let networkGuards: jest.SpyInstance[];
const tick = () => new Promise(resolve => setImmediate(resolve));
const statuses = () => telemetry.mock.calls.map(call => call[1]);

beforeEach(() => {
  jest.resetAllMocks();
  store.clear(); receipts.clear();
  jest.replaceProperty(process, 'env', {
    NODE_ENV: 'test', AZURE_TTS_ENDPOINT: 'https://offline-speech.openai.azure.com',
    AZURE_TTS_API_KEY: synthetic(), AZURE_TTS_DEPLOYMENT: 'speech-a',
    AZURE_OPENAI_IMAGE_ENDPOINT: 'https://offline-image.openai.azure.com',
    AZURE_OPENAI_IMAGE_API_KEY: synthetic(), AZURE_OPENAI_IMAGE_DEPLOYMENT: 'image-a',
    OPENROUTER_API_KEY: synthetic(), OPENROUTER_VIDEO_MODEL: prepared.model,
  });
  const forbidden = () => { throw new Error('Actual network forbidden in offline tests'); };
  networkGuards = [jest.spyOn(net, 'connect'), jest.spyOn(net, 'createConnection'), jest.spyOn(tls, 'connect'),
    jest.spyOn(http, 'request'), jest.spyOn(http, 'get'), jest.spyOn(https, 'request'), jest.spyOn(https, 'get')];
  for (const guard of networkGuards) guard.mockImplementation(forbidden);
  fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unstubbed fetch forbidden'));
  jest.mocked(supabaseAdmin.from).mockImplementation(forbidden);
  jest.mocked(supabaseAdmin.rpc).mockImplementation(forbidden);
  jest.mocked(createClient).mockImplementation(forbidden);
  telemetry.mockImplementation(async (key, status, message = '', latency_ms = 0) => {
    receipts.set(key, { status, message, latency_ms, created_at: new Date().toISOString() });
  });
  latest.mockImplementation(async key => receipts.get(key) ?? null);
  jest.mocked(sha256).mockImplementation(async value => createHash('sha256').update(value).digest('hex'));
  jest.mocked(getCachedJson).mockImplementation(async key => store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null);
  jest.mocked(setCachedJson).mockImplementation(async (key, value) => { store.set(key, JSON.parse(JSON.stringify(value))); return true; });
  jest.mocked(persistGeneratedImage).mockResolvedValue({ url: 'https://storage.example.test/image.png', b64_json: null });
  jest.mocked(submitOpenRouterVideo).mockResolvedValue({ id: 'upstream-a', status: 'pending' });
  jest.mocked(pollOpenRouterVideo).mockResolvedValue({ id: 'upstream-a', status: 'completed', generation_id: 'gen-a', usage: { cost: 0.4 } });
  jest.mocked(downloadOpenRouterVideo).mockResolvedValue({ buffer: Buffer.from('synthetic-video'), mimeType: 'video/mp4' });
  jest.mocked(persistGeneratedVideo).mockResolvedValue({ url: 'https://storage.example.test/video.mp4', mimeType: 'video/mp4' });
  jest.mocked(CreditService.deductCredits).mockResolvedValue({ success: true });
});
afterEach(() => {
  for (const guard of networkGuards) expect(guard).not.toHaveBeenCalled();
  expect(supabaseAdmin.from).not.toHaveBeenCalled(); expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(createClient).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

describe('real TTS completion observations', () => {
  it('awaits best-effort receipt only after nonempty audio validation, scoped to actual deployment', async () => {
    fetchMock.mockResolvedValueOnce(new Response('audio', { headers: { 'content-type': 'audio/mpeg' } }));
    let release!: () => void;
    telemetry.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
    let returned = false;
    const operation = synthesizeSpeech({ text: 'Hello', model: 'speech-override' }).then(value => { returned = true; return value; });
    await tick();
    expect(returned).toBe(false);
    expect(telemetry).toHaveBeenCalledWith(getTtsObservationKey('speech-override'), 'up', expect.any(String), expect.any(Number));
    release();
    expect((await operation).audio).toEqual(Buffer.from('audio'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ text: '' }, { text: 'Hello', speed: 7 }, { text: 'Hello', model: 'vendor/invalid' },
    { text: 'Hello', provider: 'other' }])('input errors never emit outage receipts: %j', async options => {
    await expect(synthesizeSpeech(options as any)).rejects.toMatchObject({ status: 400 });
    expect(telemetry).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it('missing configuration never records an attempted provider failure', async () => {
    delete process.env.AZURE_TTS_API_KEY;
    await expect(synthesizeSpeech({ text: 'Hello' })).rejects.toMatchObject({ status: 503 });
    expect(telemetry).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 422, 404])('does not count customer option/override rejection (HTTP %s) as outage', async status => {
    fetchMock.mockResolvedValueOnce(new Response('', { status }));
    await expect(synthesizeSpeech({ text: 'Hello', model: 'speech-override' })).rejects.toThrow(`(${status})`);
    expect(telemetry).not.toHaveBeenCalled();
  });

  it('does observe missing current platform deployment instead of suppressing all 404s', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(synthesizeSpeech({ text: 'Hello' })).rejects.toThrow('(404)');
    expect(statuses()).toEqual(['down']); expect(telemetry.mock.calls[0][0]).toBe(getTtsObservationKey('speech-a'));
  });

  it.each(['empty', 'json', 'oversized', 'http'])('failed or invalid provider audio records down, never up: %s', async kind => {
    const response = kind === 'json' ? Response.json({ audio: 'not audio' }) : kind === 'http' ? new Response('', { status: 503 })
      : new Response(kind === 'empty' ? '' : 'audio', { headers: { 'content-type': 'audio/mpeg',
        ...(kind === 'oversized' ? { 'content-length': String(33 * 1024 * 1024) } : {}) } });
    fetchMock.mockResolvedValueOnce(response);
    await expect(synthesizeSpeech({ text: 'Hello' })).rejects.toMatchObject({ status: 502 });
    expect(statuses()).toEqual(['down']); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('image end-to-end completion observations', () => {
  it('cannot emit up while persistence is still pending; awaits receipt and preserves partial output billing metadata', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...imageOutput, id: 'image-id', usage: { cost: 42 } }));
    let persist!: (value: { url: string; b64_json: null }) => void;
    jest.mocked(persistGeneratedImage).mockReturnValueOnce(new Promise(resolve => { persist = resolve; }));
    let emit!: () => void;
    telemetry.mockReturnValueOnce(new Promise<void>(resolve => { emit = resolve; }));
    let returned = false;
    const operation = generateWithAzure({ ...imageOptions, count: 2 }).then(value => { returned = true; return value; });
    await tick(); expect(telemetry).not.toHaveBeenCalled();
    persist({ url: 'https://storage.example.test/image.png', b64_json: null });
    await tick(); expect(returned).toBe(false);
    expect(telemetry).toHaveBeenCalledWith(getImageObservationKey('image-a'), 'up', expect.stringContaining('persistence'), expect.any(Number));
    emit();
    const result = await operation;
    expect(result.images).toHaveLength(1); expect(result.metadata).toEqual({ model: 'image-a', generation_id: 'image-id' });
    expect(CreditService.deductCredits).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { data: [] }, { data: [{ b64_json: Buffer.from('not PNG').toString('base64') }] }])('invalid output emits only down: %j', async output => {
    fetchMock.mockResolvedValueOnce(Response.json(output));
    await expect(generateWithAzure(imageOptions)).rejects.toMatchObject({ status: 502 });
    expect(statuses()).toEqual(['down']); expect(persistGeneratedImage).not.toHaveBeenCalled();
    expect(telemetry.mock.calls[0][2]).toBe('Image provider returned invalid output');
  });

  it('preserves a partial persistence failure and distinguishes it from generation failure', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [imageOutput.data[0], imageOutput.data[0]] }));
    const error = new Error(synthetic());
    jest.mocked(persistGeneratedImage).mockResolvedValueOnce({ url: 'https://storage.example.test/one.png', b64_json: null }).mockRejectedValueOnce(error);
    telemetry.mockRejectedValueOnce(new Error(synthetic()));
    await expect(generateWithAzure({ ...imageOptions, count: 2 })).rejects.toBe(error);
    expect(statuses()).toEqual(['down']); expect(telemetry.mock.calls[0][2]).toBe('Image completion failed during persistence');
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain(error.message);
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });

  it('rejects bad options/config/reference before provider attempt without receipts', async () => {
    await expect(generateWithAzure({ ...imageOptions, count: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(generateWithAzure({ ...imageOptions, model: 'vendor/invalid' })).rejects.toMatchObject({ status: 400 });
    jest.mocked(assertSafeRemoteUrl).mockRejectedValueOnce(new Error(synthetic()));
    await expect(generateWithAzure({ ...imageOptions, referenceImages: ['https://reference.example.test/image.png'] })).rejects.toMatchObject({ status: 400 });
    delete process.env.AZURE_OPENAI_IMAGE_API_KEY;
    await expect(generateWithAzure(imageOptions)).rejects.toMatchObject({ status: 503 });
    expect(telemetry).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 422, 404])('customer options/override upstream rejection does not emit outage (HTTP %s)', async status => {
    fetchMock.mockResolvedValueOnce(new Response('', { status }));
    await expect(generateWithAzure({ ...imageOptions, model: 'image-override' })).rejects.toThrow(`(${status})`);
    expect(telemetry).not.toHaveBeenCalled(); expect(persistGeneratedImage).not.toHaveBeenCalled();
  });
});

describe('video receipts represent completed persisted and billed jobs, not admission', () => {
  it('submit reporting completed is not success until the video has been persisted and billed', async () => {
    jest.mocked(submitOpenRouterVideo).mockResolvedValueOnce({ id: 'upstream-a', status: 'completed' });
    const accepted = await startVideoJob(videoBody, prepared);
    expect(accepted).toMatchObject({ status: 'in_progress', videos: [] });
    expect(telemetry).not.toHaveBeenCalled(); expect(persistGeneratedVideo).not.toHaveBeenCalled();
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });

  it('pending/in-progress and repeated completed reads never manufacture success; completion bills and persists once before awaiting receipt', async () => {
    const accepted = await startVideoJob(videoBody, prepared);
    expect(accepted.status).toBe('pending'); expect(telemetry).not.toHaveBeenCalled();
    jest.mocked(pollOpenRouterVideo).mockResolvedValueOnce({ id: 'upstream-a', status: 'in_progress' });
    expect((await resumeVideoJob(videoBody.site_id, accepted.job_id!)).status).toBe('in_progress');
    expect(telemetry).not.toHaveBeenCalled();
    let emit!: () => void;
    telemetry.mockImplementationOnce(async () => {
      const saved = store.get(`ai-video:job:${accepted.job_id}`);
      expect(saved).toMatchObject({ billed: true, status: 'completed' }); expect(saved.videos).toHaveLength(1);
      await new Promise<void>(resolve => { emit = resolve; });
    });
    let returned = false;
    const operation = resumeVideoJob(videoBody.site_id, accepted.job_id!).then(value => { returned = true; return value; });
    await tick(); expect(returned).toBe(false); emit();
    const completed = await operation;
    expect(completed.status).toBe('completed'); expect(statuses()).toEqual(['up']);
    expect(telemetry.mock.calls[0][0]).toBe(getVideoObservationKey(prepared.model));
    expect(CreditService.deductCredits).toHaveBeenCalledWith('site-a', 3.2, 'video_generation', expect.any(String), expect.objectContaining({ job_id: accepted.job_id }));
    expect(await resumeVideoJob(videoBody.site_id, accepted.job_id!)).toEqual(completed);
    expect(await startVideoJob(videoBody, prepared)).toEqual(completed);
    expect(statuses()).toEqual(['up']); expect(persistGeneratedVideo).toHaveBeenCalledTimes(1);
    expect(CreditService.deductCredits).toHaveBeenCalledTimes(1); expect(submitOpenRouterVideo).toHaveBeenCalledTimes(1);
  });

  it.each(['submit', 'poll'])('explicit terminal upstream failure emits down, never bills (%s)', async phase => {
    if (phase === 'submit') jest.mocked(submitOpenRouterVideo).mockResolvedValueOnce({ id: 'upstream-a', status: 'failed' });
    const accepted = await startVideoJob(videoBody, prepared);
    if (phase === 'poll') {
      jest.mocked(pollOpenRouterVideo).mockResolvedValueOnce({ id: 'upstream-a', status: 'failed' });
      expect((await resumeVideoJob(videoBody.site_id, accepted.job_id!)).status).toBe('failed');
    }
    expect(statuses()).toEqual(['down']); expect(CreditService.deductCredits).not.toHaveBeenCalled();
    expect(persistGeneratedVideo).not.toHaveBeenCalled();
  });

  it('ambiguous submit emits degraded and preserves ownership without retries even when telemetry fails', async () => {
    jest.mocked(submitOpenRouterVideo).mockRejectedValueOnce(new Error(synthetic()));
    telemetry.mockRejectedValueOnce(new Error(synthetic()));
    const accepted = await startVideoJob(videoBody, prepared);
    expect(accepted.error).toContain('uncertain'); expect(statuses()).toEqual(['degraded']);
    expect(await startVideoJob(videoBody, prepared)).toEqual(accepted);
    expect(await resumeVideoJob(videoBody.site_id, accepted.job_id!)).toEqual(accepted);
    expect(submitOpenRouterVideo).toHaveBeenCalledTimes(1); expect(pollOpenRouterVideo).not.toHaveBeenCalled();
    expect(CreditService.deductCredits).not.toHaveBeenCalled();
  });

  it.each(['persistence', 'billing', 'final-save'])('does not report up when functional completion fails: %s', async phase => {
    const accepted = await startVideoJob(videoBody, prepared);
    const error = new Error(synthetic());
    if (phase === 'persistence') jest.mocked(persistGeneratedVideo).mockRejectedValueOnce(error);
    if (phase === 'billing') jest.mocked(CreditService.deductCredits).mockRejectedValueOnce(error);
    if (phase === 'final-save') jest.mocked(setCachedJson).mockImplementation(async (key, value: any) => {
      if (value.status === 'completed') return false;
      store.set(key, JSON.parse(JSON.stringify(value))); return true;
    });
    await expect(resumeVideoJob(videoBody.site_id, accepted.job_id!)).rejects.toThrow();
    expect(statuses()).not.toContain('up');
    if (phase === 'persistence') expect(statuses()).toEqual(['down']);
    if (phase === 'billing') {
      expect((await resumeVideoJob(videoBody.site_id, accepted.job_id!)).error).toContain('reconciliation');
      expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
    }
  });

  it('customer submission errors and failed admission/authorization never emit outage', async () => {
    jest.mocked(setCachedJson).mockResolvedValueOnce(false);
    await expect(startVideoJob(videoBody, prepared)).rejects.toMatchObject({ status: 503 });
    expect(submitOpenRouterVideo).not.toHaveBeenCalled();
    jest.mocked(submitOpenRouterVideo).mockRejectedValueOnce(new MediaRequestError('OpenRouter media request failed (400)'));
    const accepted = await startVideoJob(videoBody, prepared);
    await expect(resumeVideoJob('foreign-site', accepted.job_id!)).rejects.toMatchObject({ status: 404 });
    expect(telemetry).not.toHaveBeenCalled(); expect(pollOpenRouterVideo).not.toHaveBeenCalled();
  });

  it.each(['422', '404', 'missing-config'])('does not count invalid override/options or absent submit configuration as platform outage: %s', async kind => {
    const error = new MediaRequestError(kind === 'missing-config' ? 'OpenRouter is not configured: set OPENROUTER_API_KEY'
      : `OpenRouter media request failed (${kind})`);
    jest.mocked(submitOpenRouterVideo).mockRejectedValueOnce(error);
    await startVideoJob(videoBody, { ...prepared, model: 'vendor/video-override' });
    expect(telemetry).not.toHaveBeenCalled(); expect(submitOpenRouterVideo).toHaveBeenCalledTimes(1);
  });

  it('unsuccessful billing remains unbilled without a success receipt or automatic recharge', async () => {
    const accepted = await startVideoJob(videoBody, prepared);
    jest.mocked(CreditService.deductCredits).mockResolvedValueOnce({ success: false });
    const incomplete = await resumeVideoJob(videoBody.site_id, accepted.job_id!);
    expect(incomplete.videos).toEqual([]); expect(incomplete.error).toContain('reconciliation');
    expect(telemetry).not.toHaveBeenCalled();
    expect((await resumeVideoJob(videoBody.site_id, accepted.job_id!)).error).toContain('reconciliation');
    expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
  });
});

describe('passive media readers and security', () => {
  it('telemetry rejection never changes successful audio, image output or completed/billed video behavior', async () => {
    telemetry.mockRejectedValue(new Error(synthetic()));
    fetchMock.mockResolvedValueOnce(new Response('audio', { headers: { 'content-type': 'audio/mpeg' } }))
      .mockResolvedValueOnce(Response.json(imageOutput));
    await expect(synthesizeSpeech({ text: 'Hello' })).resolves.toMatchObject({ audio: Buffer.from('audio') });
    await expect(generateWithAzure(imageOptions)).resolves.toMatchObject({ images: [{ b64_json: null }] });
    const accepted = await startVideoJob(videoBody, prepared);
    await expect(resumeVideoJob(videoBody.site_id, accepted.job_id!)).resolves.toMatchObject({ status: 'completed' });
    expect(statuses()).toEqual(['up', 'up', 'up']); expect(CreditService.deductCredits).toHaveBeenCalledTimes(1);
  });

  it('missing or unavailable evidence stays configuration-only without inference or recoloring configuration failures', async () => {
    expect(await aiImageHandler.runCheck()).toMatchObject({ status: 'skipped', checks: { verification: 'configuration' } });
    expect(await aiVideoHandler.runCheck()).toMatchObject({ status: 'skipped', checks: { verification: 'configuration' } });
    latest.mockRejectedValue(new Error(synthetic()));
    expect(await aiImageHandler.runCheck()).toMatchObject({ status: 'skipped', checks: { verification: 'configuration' } });
    expect(await aiVideoHandler.runCheck()).toMatchObject({ status: 'skipped', checks: { verification: 'configuration' } });
    delete process.env.AZURE_OPENAI_IMAGE_API_KEY;
    expect((await aiImageHandler.runCheck()).status).toBe('down'); // Preserve existing missing-image-config semantics.
    expect(fetchMock).not.toHaveBeenCalled(); expect(submitOpenRouterVideo).not.toHaveBeenCalled();
  });

  it('uses real successful receipts for current configured models without new provider calls', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(imageOutput));
    await generateWithAzure(imageOptions);
    const accepted = await startVideoJob(videoBody, prepared);
    await resumeVideoJob(videoBody.site_id, accepted.job_id!);
    const image = await aiImageHandler.runCheck(); const video = await aiVideoHandler.runCheck();
    expect(image).toMatchObject({ status: 'up', checks: { verification: 'passive' } });
    expect(image.summary).toContain('persistence completed');
    expect(video).toMatchObject({ status: 'up', checks: { verification: 'passive' } });
    expect(video.summary).toContain('billing completed');
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(submitOpenRouterVideo).toHaveBeenCalledTimes(1);
    expect(pollOpenRouterVideo).toHaveBeenCalledTimes(1);
  });

  it('override receipts cannot verify configured models; stale/current-disabled evidence remains unverified', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(imageOutput));
    await generateWithAzure({ ...imageOptions, model: 'image-override' });
    const accepted = await startVideoJob(videoBody, { ...prepared, model: 'vendor/video-override' });
    await resumeVideoJob(videoBody.site_id, accepted.job_id!);
    for (const handler of [aiImageHandler, aiVideoHandler]) {
      expect(await handler.runCheck()).toMatchObject({ status: 'skipped', checks: { verification: 'configuration' } });
    }
    process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT = 'image-override';
    process.env.OPENROUTER_VIDEO_MODEL = 'vendor/video-override';
    expect((await aiImageHandler.runCheck()).status).toBe('up'); expect((await aiVideoHandler.runCheck()).status).toBe('up');
    for (const receipt of receipts.values()) receipt.created_at = new Date(Date.now() - AI_OBSERVATION_MAX_AGE_MS - 1).toISOString();
    expect((await aiImageHandler.runCheck()).status).toBe('skipped'); expect((await aiVideoHandler.runCheck()).status).toBe('skipped');
    delete process.env.OPENROUTER_API_KEY;
    expect((await aiVideoHandler.runCheck()).status).toBe('skipped');
  });

  it.each(['down', 'degraded'] as const)('retains observed %s evidence instead of turning it into up', async status => {
    for (const key of [getImageObservationKey('image-a'), getVideoObservationKey(prepared.model)]) {
      receipts.set(key, { status, message: '', latency_ms: 3, created_at: new Date().toISOString() });
    }
    expect((await aiImageHandler.runCheck()).status).toBe(status); expect((await aiVideoHandler.runCheck()).status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled(); expect(submitOpenRouterVideo).not.toHaveBeenCalled();
  });

  it('emits safe fixed labels without credentials, prompts, bodies or authenticated URLs and preserves errors', async () => {
    const url = new URL('https://provider.example.test/media');
    url.username = synthetic(); url.password = synthetic(); url.searchParams.set('token', synthetic());
    const bodySecret = synthetic(); const prompt = synthetic();
    const sensitive = [bodySecret, prompt, url.username, url.password, url.searchParams.get('token')!, url.toString(),
      process.env.AZURE_TTS_API_KEY!, process.env.AZURE_OPENAI_IMAGE_API_KEY!, process.env.OPENROUTER_API_KEY!];
    const rawError = new Error(sensitive.join(' '));
    const logs = [jest.spyOn(console, 'error').mockImplementation(() => {}), jest.spyOn(console, 'warn').mockImplementation(() => {}),
      jest.spyOn(console, 'log').mockImplementation(() => {})];
    fetchMock.mockRejectedValueOnce(rawError).mockRejectedValueOnce(rawError);
    const ttsError = await synthesizeSpeech({ text: prompt }).catch(error => error);
    const imageError = await generateWithAzure({ ...imageOptions, prompt }).catch(error => error);
    jest.mocked(submitOpenRouterVideo).mockRejectedValueOnce(rawError);
    const video = await startVideoJob({ ...videoBody, prompt }, { ...prepared, prompt });
    expect(statuses()).toEqual(['down', 'down', 'degraded']);
    const safeOutput = JSON.stringify(telemetry.mock.calls) + String(ttsError) + String(imageError) + JSON.stringify(video)
      + JSON.stringify(logs.map(log => log.mock.calls));
    // Prompt is intentionally preserved in private job persistence, but never in public receipts/results/errors.
    for (const value of sensitive) expect(safeOutput).not.toContain(value);
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(submitOpenRouterVideo).toHaveBeenCalledTimes(1);
  });
});