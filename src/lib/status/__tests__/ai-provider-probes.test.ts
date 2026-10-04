import { randomBytes } from 'node:crypto';
import { evaluateAiProviders, isAiProbeEnabled } from '@/lib/status/types';
import type { ProviderProbeResult } from '@/lib/status/types';
import { createOpenRouterClient } from '@/lib/services/ai/openrouter';
import { checkAzureImage, checkOpenRouterMedia, checkTranscriptionProvider, checkTtsProvider, probeOpenRouterText } from '@/lib/status/handlers/ai/provider-probes';
import { aiOpenRouterHandler } from '@/lib/status/handlers/ai/openrouter';
import { aiTextHandler } from '@/lib/status/handlers/ai/text';
import { aiImageHandler } from '@/lib/status/handlers/ai/image';
import { aiVideoHandler } from '@/lib/status/handlers/ai/video';
import { aiAudioHandler } from '@/lib/status/handlers/ai/audio';
import { SYSTEM_LABELS } from '@/lib/status/system-labels';

const mockCompletion = jest.fn();
jest.mock('@/lib/services/ai/openrouter', () => ({
  ...jest.requireActual('@/lib/services/ai/openrouter'),
  createOpenRouterClient: jest.fn(() => ({ chat: { completions: { create: mockCompletion } } })),
}));

describe('evaluateAiProviders', () => {
  const up = (overrides: Partial<ProviderProbeResult> = {}): ProviderProbeResult => ({
    configured: true,
    liveProbe: true,
    latencyMs: 10,
    model: 'test',
    ...overrides,
  });

  const failed = (): ProviderProbeResult => ({
    configured: true,
    liveProbe: false,
    latencyMs: 10,
    model: 'test',
    errorCode: 'AUTH_FAILED',
  });

  it('returns degraded when non-primary provider fails', () => {
    const { status, degradedReasons } = evaluateAiProviders(
      { azure: up(), gemini: failed() },
      ['azure'],
    );
    expect(status).toBe('degraded');
    expect(degradedReasons.some((r) => r.includes('gemini'))).toBe(true);
  });

  it('returns down when all primary providers fail live probe', () => {
    const { status } = evaluateAiProviders({ azure: failed() }, ['azure']);
    expect(status).toBe('down');
  });

  it('returns up when all configured providers pass', () => {
    const { status } = evaluateAiProviders(
      { azure: up(), gemini: up() },
      ['azure'],
    );
    expect(status).toBe('up');
  });

  it('returns down when no providers configured but primary required', () => {
    const { status } = evaluateAiProviders(
      {
        azure: { configured: false, liveProbe: false, latencyMs: 0, model: 'x', skipped: true },
      },
      ['azure'],
    );
    expect(status).toBe('down');
  });

  it('treats configured without liveProbe as down for sole primary', () => {
    const { status } = evaluateAiProviders(
      {
        azure: { configured: true, liveProbe: false, latencyMs: 0, model: 'x', errorCode: 'PROBE_DISABLED' },
      },
      ['azure'],
    );
    expect(status).toBe('down');
  });

  it('reports configuration-only readiness as unverified rather than failed inference', () => {
    const result = evaluateAiProviders({ openrouter: up({ liveProbe: false, verification: 'configuration' }) }, ['openrouter']);
    expect(result).toEqual({ status: 'degraded', degradedReasons: ['openrouter_generation_unverified'] });
  });
});

describe('capability-specific status probes (offline)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test' });
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network forbidden in offline tests'));
    mockCompletion.mockReset().mockResolvedValue({ choices: [] });
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([undefined, 'false', '1'])('requires explicit opt-in even on CI/production (%s)', async (enabled) => {
    Object.assign(process.env, { OPENROUTER_API_KEY: randomBytes(32).toString('hex'), NODE_ENV: 'production', CI: 'true', VERCEL: '1' });
    if (enabled !== undefined) process.env.STATUS_AI_PROBE_ENABLED = enabled;
    expect(isAiProbeEnabled()).toBe(false);
    expect(await probeOpenRouterText()).toMatchObject({ configured: true, liveProbe: false, errorCode: 'PROBE_DISABLED' });
    expect(createOpenRouterClient).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not accept legacy credentials as OpenRouter configuration', async () => {
    for (const name of ['PORTKEY_API_KEY', 'AZURE_OPENAI_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
      process.env[name] = randomBytes(32).toString('hex');
    }
    process.env.STATUS_AI_PROBE_ENABLED = 'true';
    expect(await probeOpenRouterText()).toMatchObject({ configured: false, skipped: true });
    expect(createOpenRouterClient).not.toHaveBeenCalled();
  });

  it('uses the shared OpenRouter client and default qualified chat model only when opted in', async () => {
    process.env.OPENROUTER_API_KEY = randomBytes(32).toString('hex');
    process.env.STATUS_AI_PROBE_ENABLED = 'true';
    expect(await probeOpenRouterText()).toMatchObject({ model: 'openai/gpt-6.1-sol', liveProbe: true });
    expect(createOpenRouterClient).toHaveBeenCalledWith({ timeout: 15_000, maxRetries: 0 });
    expect(mockCompletion).toHaveBeenCalledWith({
      model: 'openai/gpt-6.1-sol', messages: [{ role: 'user', content: 'ping' }], stream: false, max_completion_tokens: 100,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('preserves configured qualified model IDs', async () => {
    Object.assign(process.env, { OPENROUTER_API_KEY: randomBytes(32).toString('hex'), OPENROUTER_CHAT_MODEL: 'anthropic/claude-sonnet-4', STATUS_AI_PROBE_ENABLED: 'true' });
    expect(await probeOpenRouterText()).toMatchObject({ model: 'anthropic/claude-sonnet-4' });
    expect(mockCompletion.mock.calls[0][0]).toMatchObject({ model: 'anthropic/claude-sonnet-4', max_tokens: 10 });
  });

  it.each([[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [429, 'QUOTA_EXCEEDED'], [500, 'PROVIDER_ERROR']])('publishes safe errors without retries (%s)', async (status, errorCode) => {
    const key = randomBytes(32).toString('hex');
    const username = randomBytes(16).toString('hex');
    const password = randomBytes(24).toString('hex');
    const token = randomBytes(24).toString('hex');
    const url = new URL('https://example.invalid/probe');
    url.username = username;
    url.password = password;
    url.searchParams.set('token', token);
    Object.assign(process.env, { OPENROUTER_API_KEY: key, STATUS_AI_PROBE_ENABLED: 'true' });
    mockCompletion.mockRejectedValue(Object.assign(new Error(`${url} ${key}`), { status }));
    const result = await probeOpenRouterText();
    expect(result).toMatchObject({ liveProbe: false, configured: true, errorCode });
    for (const sensitive of [key, username, password, token]) expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(mockCompletion).toHaveBeenCalledTimes(1);
  });

  it('reflects media configuration without running unrelated text inference', async () => {
    Object.assign(process.env, { OPENROUTER_API_KEY: randomBytes(32).toString('hex'), STATUS_AI_PROBE_ENABLED: 'true' });
    expect(checkAzureImage()).toMatchObject({ configured: false, liveProbe: false });
    Object.assign(process.env, {
      MICROSOFT_AZURE_OPENAI_ENDPOINT: 'https://status-test.openai.azure.com',
      MICROSOFT_AZURE_OPENAI_API_KEY: randomBytes(32).toString('hex'),
    });
    expect(checkAzureImage()).toMatchObject({ configured: true, model: 'gpt-image-2.5-sunburst', liveProbe: false });
    for (const mode of ['video'] as const) {
      expect(checkOpenRouterMedia(mode)).toMatchObject({ configured: false, skipped: true });
      process.env[`OPENROUTER_${mode.toUpperCase()}_MODEL`] = `test/${mode}`;
      expect(checkOpenRouterMedia(mode)).toMatchObject({ configured: true, model: `test/${mode}`, verification: 'configuration' });
    }
    const image = await aiImageHandler.runCheck();
    const video = await aiVideoHandler.runCheck();
    expect(image).toMatchObject({ status: 'degraded', checks: { providers: { azure: { configured: true } } } });
    expect(video.status).toBe('degraded');
    expect(mockCompletion).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails Azure image readiness closed on invalid config without exposing secrets or fetching', async () => {
    const key = randomBytes(32).toString('hex');
    const url = new URL('https://config.example.invalid');
    url.password = key; url.username = randomBytes(12).toString('hex');
    Object.assign(process.env, { AZURE_OPENAI_IMAGE_ENDPOINT: url.toString(), AZURE_OPENAI_IMAGE_API_KEY: key });
    const result = await aiImageHandler.runCheck();
    expect(result).toMatchObject({ status: 'down', checks: { providers: { azure: { configured: false } } } });
    for (const sensitive of [key, url.username, url.toString()]) expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('checks TTS configuration on Azure directly and ignores OpenRouter readiness', async () => {
    process.env.AI_TTS_PROVIDER = 'openrouter';
    process.env.OPENROUTER_TTS_MODEL = 'microsoft/mai-voice-2.1';
    process.env.OPENROUTER_API_KEY = randomBytes(32).toString('hex');
    expect(checkTtsProvider()).toMatchObject({ provider: 'azure', result: { configured: false, skipped: true } });
    Object.assign(process.env, {
      AZURE_TTS_API_KEY: randomBytes(32).toString('hex'),
      AZURE_TTS_ENDPOINT: 'https://test.openai.azure.com/openai/v1/',
      STATUS_AI_PROBE_ENABLED: 'true',
    });
    expect(checkTtsProvider()).toEqual({ provider: 'azure', result: {
      configured: true, model: 'tts-hd', verification: 'configuration', liveProbe: false, latencyMs: 0,
    } });
    delete process.env.OPENROUTER_API_KEY;
    process.env.AZURE_TTS_DEPLOYMENT = 'custom-speech';
    expect(checkTtsProvider()).toMatchObject({ provider: 'azure', result: { configured: true, model: 'custom-speech' } });
    expect(await aiAudioHandler.runCheck()).toMatchObject({
      status: 'degraded', checks: { ttsProvider: 'azure', transcriptionProvider: 'azure-direct', verification: 'configuration' },
    });
    expect(createOpenRouterClient).not.toHaveBeenCalled();
    expect(mockCompletion).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('checks transcription on Azure direct only', async () => {
    process.env.AI_TRANSCRIPTION_PROVIDER = 'gemini';
    process.env.OPENROUTER_API_KEY = randomBytes(32).toString('hex');
    expect(checkTranscriptionProvider().result.configured).toBe(false);
    process.env.OPENROUTER_TRANSCRIPTION_MODEL = 'vendor/stt';
    expect(checkTranscriptionProvider().result.configured).toBe(false);
    Object.assign(process.env, {
      MICROSOFT_AZURE_OPENAI_ENDPOINT: 'https://test.openai.azure.com',
      MICROSOFT_AZURE_OPENAI_API_KEY: randomBytes(32).toString('hex'),
      AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT: 'test-transcribe',
    });
    expect(checkTranscriptionProvider()).toMatchObject({ provider: 'azure-direct', result: {
      configured: true, model: 'test-transcribe', verification: 'configuration', liveProbe: false,
    } });
    delete process.env.OPENROUTER_API_KEY;
    expect(checkTranscriptionProvider().result.configured).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not expose invalid transcription endpoint credentials in readiness', () => {
    const url = new URL('https://config.example.invalid');
    url.username = randomBytes(12).toString('hex'); url.password = randomBytes(24).toString('hex');
    Object.assign(process.env, { AZURE_OPENAI_TRANSCRIPTION_ENDPOINT: url.toString(),
      AZURE_OPENAI_TRANSCRIPTION_API_KEY: randomBytes(24).toString('hex'),
      AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT: 'test-transcribe' });
    const result = checkTranscriptionProvider();
    expect(result.result.configured).toBe(false);
    for (const value of [url.username, url.password, url.toString(), process.env.AZURE_OPENAI_TRANSCRIPTION_API_KEY!]) {
      expect(JSON.stringify(result)).not.toContain(value);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not count obsolete OpenRouter speech or transcription configuration as readiness', () => {
    process.env.OPENROUTER_API_KEY = randomBytes(32).toString('hex');
    process.env.OPENROUTER_TTS_MODEL = 'tts-hd';
    process.env.OPENROUTER_TRANSCRIPTION_MODEL = 'whisper-1';
    expect(checkTtsProvider().result.configured).toBe(false);
    expect(checkTranscriptionProvider().result.configured).toBe(false);
  });

  it.each(['credentials', 'query', 'host', 'deployment', 'version', 'voice'])('fails Azure TTS configuration closed without exposing sensitive settings (%s)', async mode => {
    const key = randomBytes(32).toString('hex');
    const username = randomBytes(12).toString('hex');
    const password = randomBytes(24).toString('hex');
    const token = randomBytes(24).toString('hex');
    const url = new URL(mode === 'host' ? 'https://config.example.invalid' : 'https://test.openai.azure.com');
    if (mode === 'credentials') { url.username = username; url.password = password; }
    if (mode === 'query') url.searchParams.set('token', token);
    Object.assign(process.env, { AZURE_TTS_ENDPOINT: url.toString(), AZURE_TTS_API_KEY: key, STATUS_AI_PROBE_ENABLED: 'true' });
    if (mode === 'deployment') process.env.AZURE_TTS_DEPLOYMENT = 'provider/tts-hd';
    if (mode === 'version') process.env.AZURE_TTS_API_VERSION = 'v1';
    if (mode === 'voice') process.env.AZURE_TTS_VOICE = ' ';
    const result = await aiAudioHandler.runCheck();
    expect(result).toMatchObject({ status: 'skipped', checks: { ttsProvider: 'azure', providers: { tts: { configured: false, skipped: true } } } });
    for (const sensitive of [key, username, password, token, url.toString()]) {
      expect(JSON.stringify(result)).not.toContain(sensitive);
    }
    expect(global.fetch).not.toHaveBeenCalled();
    expect(createOpenRouterClient).not.toHaveBeenCalled();
  });

  it('retains the persisted ai_portkey key while labeling and checking OpenRouter', async () => {
    expect(SYSTEM_LABELS.ai_portkey).toBe('AI OpenRouter');
    const result = await aiOpenRouterHandler.runCheck();
    expect(result).toMatchObject({ systemKey: 'ai_portkey', label: 'AI OpenRouter (/api/ai)', status: 'down' });
    expect(await aiTextHandler.runCheck()).toMatchObject({ status: 'down', checks: { providers: { openrouter: { configured: false } } } });
  });
});
