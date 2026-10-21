jest.mock('@/lib/status/telemetry', () => ({
  getLatestTelemetry: jest.fn().mockResolvedValue(null),
  recordTelemetry: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/services/ai/openrouter', () => ({
  ...jest.requireActual('@/lib/services/ai/openrouter'),
  createOpenRouterClient: jest.fn(),
}));
jest.mock('@/lib/services/billing/openrouter-usage-billing', () => ({ chargeOpenRouterUsage: jest.fn() }));
jest.mock('@/lib/services/twilio/fetchTwilioMedia', () => ({ fetchTwilioMedia: jest.fn(), isTwilioMediaUrl: jest.fn() }));

import { randomBytes } from 'node:crypto';
import { getLatestTelemetry, recordTelemetry } from '@/lib/status/telemetry';
import type { TelemetryRecord } from '@/lib/status/telemetry';
import type { ProviderProbeResult } from '@/lib/status/types';
import {
  AI_OBSERVATION_MAX_AGE_MS, getTextObservationKey, getTranscriptionObservationKey,
  getTtsObservationKey, readPassiveProviderObservation,
} from '@/lib/status/handlers/ai/passive-probes';
import { aiOpenRouterHandler } from '@/lib/status/handlers/ai/openrouter';
import { aiTextHandler } from '@/lib/status/handlers/ai/text';
import { aiAudioHandler } from '@/lib/status/handlers/ai/audio';
import { createOpenRouterClient, getOpenRouterChatModel } from '@/lib/services/ai/openrouter';
import { OpenRouterConnector } from '@/lib/agentbase/services/PortkeyConnector';
import { chargeOpenRouterUsage } from '@/lib/services/billing/openrouter-usage-billing';
import { transcribeAudioBuffer } from '@/lib/services/ai/transcribeAudio';

const synthetic = () => randomBytes(24).toString('hex');
const configuration = (model = 'vendor/model'): ProviderProbeResult => ({
  configured: true, liveProbe: false, latencyMs: 0, model, verification: 'configuration',
  errorCode: 'PROBE_DISABLED',
});
const receipt = (status: TelemetryRecord['status'] = 'up', age = 0): TelemetryRecord => ({
  status, message: '', latency_ms: 42, created_at: new Date(Date.now() - age).toISOString(),
});
const messages = [{ role: 'system' as const, content: 'Agent instructions' }, { role: 'user' as const, content: 'Question' }];
const mockCreate = jest.fn();
const telemetry = jest.mocked(recordTelemetry);
const latest = jest.mocked(getLatestTelemetry);
const billing = jest.mocked(chargeOpenRouterUsage);
const consume = async (stream: AsyncIterable<any>) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};
const configureAudio = () => Object.assign(process.env, {
  MICROSOFT_AZURE_OPENAI_ENDPOINT: 'https://passive-test.openai.azure.com',
  MICROSOFT_AZURE_OPENAI_API_KEY: synthetic(), AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT: 'transcribe-a',
  AZURE_TTS_ENDPOINT: 'https://passive-test.openai.azure.com/openai/v1/',
  AZURE_TTS_API_KEY: synthetic(), AZURE_TTS_DEPLOYMENT: 'speech-a',
});

beforeEach(() => {
  jest.replaceProperty(process, 'env', { NODE_ENV: 'test', OPENROUTER_API_KEY: synthetic() });
  latest.mockReset().mockResolvedValue(null);
  telemetry.mockReset().mockResolvedValue(undefined);
  billing.mockReset().mockResolvedValue(undefined);
  mockCreate.mockReset().mockResolvedValue({ choices: [{ message: { content: 'Answer' } }] });
  jest.mocked(createOpenRouterClient).mockReset().mockReturnValue({ chat: { completions: { create: mockCreate } } } as any);
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network forbidden in offline tests'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('model- and capability-scoped passive evidence', () => {
  it('keeps distinct stable hashed keys for models and audio capabilities', () => {
    const model = 'vendor/model';
    expect(getTextObservationKey(model)).toMatch(/^ai_text_openrouter_[a-f0-9]{64}$/);
    expect(getTextObservationKey(model)).toBe(getTextObservationKey(model));
    expect(new Set([getTextObservationKey(model), getTextObservationKey('vendor/other'),
      getTranscriptionObservationKey(model), getTtsObservationKey(model)]).size).toBe(4);
    expect(getTextObservationKey(model)).not.toContain(model);
  });

  it.each(['up', 'down', 'degraded'] as const)('reads actual %s without calling inference or exposing receipt messages', async status => {
    const secret = synthetic();
    const url = new URL('https://receipt.example.invalid');
    url.username = synthetic(); url.password = synthetic(); url.searchParams.set('token', secret);
    const observation = { ...receipt(status), message: `${url} ${process.env.OPENROUTER_API_KEY}` };
    latest.mockResolvedValue(observation);
    const result = await readPassiveProviderObservation(configuration(), getTextObservationKey('vendor/model'));
    expect(result).toMatchObject({ verification: 'passive', liveProbe: false,
      observedStatus: status, observedHealthy: status === 'up', observedAt: observation.created_at, latencyMs: 42 });
    if (status === 'up') expect(result.errorCode).toBeUndefined();
    else expect(result.errorCode).toBe('OBSERVED_PROVIDER_FAILURE');
    for (const sensitive of [secret, url.username, url.password, process.env.OPENROUTER_API_KEY!]) {
      expect(JSON.stringify(result)).not.toContain(sensitive);
    }
    expect(global.fetch).not.toHaveBeenCalled();
    expect(createOpenRouterClient).not.toHaveBeenCalled();
  });

  it.each([null, receipt('up', AI_OBSERVATION_MAX_AGE_MS + 1000), receipt('up', -60_000),
    receipt('skipped'), { ...receipt(), created_at: 'invalid' }])('leaves missing/stale/invalid evidence unverified (%j)', async observation => {
    latest.mockResolvedValue(observation);
    const result = configuration();
    expect(await readPassiveProviderObservation(result, getTextObservationKey(result.model))).toBe(result);
  });

  it('fails closed on telemetry lookup failure and never replaces missing configuration', async () => {
    latest.mockRejectedValueOnce(new Error(synthetic()));
    const result = configuration();
    expect(await readPassiveProviderObservation(result, getTextObservationKey(result.model))).toBe(result);
    latest.mockClear().mockResolvedValue(receipt());
    const missing = { ...result, configured: false, skipped: true };
    expect(await readPassiveProviderObservation(missing, getTextObservationKey(missing.model))).toBe(missing);
    expect(latest).not.toHaveBeenCalled();
  });

  it('uses only the configured text model, not generic telemetry or another model receipt', async () => {
    const otherKey = getTextObservationKey('vendor/other');
    latest.mockImplementation(async key => key === otherKey || key === 'ai_portkey' ? receipt() : null);
    for (const handler of [aiOpenRouterHandler, aiTextHandler]) {
      expect(await handler.runCheck()).toMatchObject({ status: 'skipped', checks: { verification: 'configuration' } });
    }
    expect(latest).toHaveBeenCalledWith(getTextObservationKey(getOpenRouterChatModel()), 0.25);
    expect(createOpenRouterClient).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(['up', 'down'] as const)('presents recent text %s as passive, never live', async status => {
    latest.mockResolvedValue(receipt(status));
    for (const handler of [aiOpenRouterHandler, aiTextHandler]) {
      expect(await handler.runCheck()).toMatchObject({ status, checks: { verification: 'passive',
        observedFailure: status === 'down', providers: { openrouter: { liveProbe: false, observedStatus: status } } } });
    }
    expect(createOpenRouterClient).not.toHaveBeenCalled();
  });

  it('retains explicitly enabled active text probing rather than passive fallback', async () => {
    process.env.STATUS_AI_PROBE_ENABLED = 'true';
    latest.mockResolvedValue(receipt('down'));
    expect(await aiTextHandler.runCheck()).toMatchObject({ status: 'up', checks: { verification: 'inference' } });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(latest).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keeps transcription success partial and TTS unverified independently', async () => {
    configureAudio();
    latest.mockImplementation(async key => key === getTranscriptionObservationKey('transcribe-a') ? receipt() : null);
    expect(await aiAudioHandler.runCheck()).toMatchObject({ status: 'degraded', checks: {
      verification: 'partial', observedFailure: false, providers: {
        transcription: { verification: 'passive', observedHealthy: true },
        tts: { verification: 'configuration', liveProbe: false },
      },
    } });
    delete process.env.AZURE_TTS_API_KEY;
    expect(await aiAudioHandler.runCheck()).toMatchObject({ status: 'degraded', checks: {
      verification: 'partial', providers: { tts: { configured: false, skipped: true } },
    } });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('ignores stale or wrong-model audio receipts; all missing evidence is skipped', async () => {
    configureAudio();
    latest.mockImplementation(async key => key === getTranscriptionObservationKey('transcribe-a')
      ? receipt('up', AI_OBSERVATION_MAX_AGE_MS + 1000) : key === getTranscriptionObservationKey('other') ? receipt() : null);
    expect(await aiAudioHandler.runCheck()).toMatchObject({ status: 'skipped', checks: { verification: 'configuration' } });
    delete process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT;
    delete process.env.AZURE_TTS_API_KEY;
    latest.mockClear().mockResolvedValue(receipt());
    expect(await aiAudioHandler.runCheck()).toMatchObject({ status: 'skipped' });
    expect(latest).not.toHaveBeenCalled();
  });

  it.each(['down', 'degraded'] as const)('reports actual audio %s independently of unobserved TTS', async status => {
    configureAudio();
    latest.mockImplementation(async key => key === getTranscriptionObservationKey('transcribe-a') ? receipt(status) : null);
    expect(await aiAudioHandler.runCheck()).toMatchObject({ status: 'down', checks: {
      verification: 'partial', observedFailure: true, providers: { transcription: { observedStatus: status } },
    } });
  });

  it('requires both capability receipts for fully verified audio and keeps TTS failures independent', async () => {
    configureAudio();
    latest.mockImplementation(async key => [getTtsObservationKey('speech-a'), getTranscriptionObservationKey('transcribe-a')]
      .includes(key) ? receipt() : null);
    expect(await aiAudioHandler.runCheck()).toMatchObject({ status: 'up', checks: {
      verification: 'passive', observedFailure: false, providers: {
        transcription: { observedHealthy: true, liveProbe: false }, tts: { observedHealthy: true, liveProbe: false },
      },
    } });
    latest.mockImplementation(async key => key === getTtsObservationKey('speech-a') ? receipt('down') : receipt());
    expect(await aiAudioHandler.runCheck()).toMatchObject({ status: 'down', checks: {
      verification: 'passive', observedFailure: true, providers: {
        transcription: { observedHealthy: true }, tts: { observedHealthy: false, observedStatus: 'down' },
      },
    } });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('real text request observation without billing/stream changes', () => {
  it('does not let a custom credential verify platform health for the same model', async () => {
    const customKey = synthetic();
    await new OpenRouterConnector({ apiKey: customKey }).callAgent(messages);
    mockCreate.mockRejectedValueOnce(new Error(synthetic()));
    await expect(new OpenRouterConnector({ apiKey: customKey }).callAgent(messages)).rejects.toThrow();
    expect(telemetry).not.toHaveBeenCalled();
    await new OpenRouterConnector({ apiKey: process.env.OPENROUTER_API_KEY }).callAgent(messages);
    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain(customKey);
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain(process.env.OPENROUTER_API_KEY!);
  });

  it('awaits a model-scoped non-stream completion receipt', async () => {
    let resolveReceipt!: () => void;
    telemetry.mockReturnValue(new Promise<void>(resolve => { resolveReceipt = resolve; }));
    let completed = false;
    const request = new OpenRouterConnector().callAgent(messages).then(result => { completed = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    expect(telemetry).toHaveBeenCalledWith(getTextObservationKey(getOpenRouterChatModel()), 'up', expect.any(String), expect.any(Number));
    expect(completed).toBe(false);
    resolveReceipt();
    expect((await request).content).toBe('Answer');
  });

  it.each([
    { choices: [] }, { choices: [{ message: { content: '  ' } }] }, { choices: [{ message: { tool_calls: [{}] } }] },
  ])('does not mark accepted empty completion up, while preserving accepted billing (%j)', async response => {
    mockCreate.mockResolvedValue({ ...response, id: 'generation-empty', usage: { cost: 0.01 } });
    await new OpenRouterConnector().callAgent(messages, { siteId: 'site-a' });
    expect(billing).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledWith(getTextObservationKey(getOpenRouterChatModel()), 'down', expect.any(String), expect.any(Number));
    expect(telemetry).not.toHaveBeenCalledWith(expect.any(String), 'up', expect.any(String), expect.any(Number));
  });

  it('allows completed tool generation as evidence without changing normalized result', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { tool_calls: [{ function: { name: 'lookup', arguments: '{}' } }] } }] });
    const result = await new OpenRouterConnector().callAgent(messages);
    expect(result.content).toBe('');
    expect(telemetry.mock.calls[0][1]).toBe('up');
  });

  it('does not emit success on stream acceptance, and preserves chunks and billing settlement', async () => {
    const chunks = [{ id: 'generation-stream', choices: [{ delta: { content: 'Answer' } }] },
      { choices: [], usage: { cost: 0.01 } }];
    mockCreate.mockResolvedValue((async function* () { yield* chunks; })());
    const result = await new OpenRouterConnector().callAgent(messages, { stream: true, siteId: 'site-a' });
    expect(telemetry).not.toHaveBeenCalled();
    expect(billing).not.toHaveBeenCalled();
    expect(await consume(result.stream)).toEqual(chunks);
    expect(billing).toHaveBeenCalledTimes(1);
    expect(billing).toHaveBeenCalledWith(expect.objectContaining({ generationId: 'generation-stream', usage: { cost: 0.01 } }));
    expect(telemetry.mock.calls[0][1]).toBe('up');
    expect(billing.mock.invocationCallOrder[0]).toBeLessThan(telemetry.mock.invocationCallOrder[0]);
  });

  it('records completed tool streams but not empty or error-envelope streams without billing sites', async () => {
    for (const [chunk, expected] of [
      [{ choices: [{ delta: { tool_calls: [{ function: { name: 'lookup' } }] } }] }, 'up'],
      [{ choices: [], usage: { cost: 0.01 } }, 'down'],
      [{ error: { message: synthetic() }, choices: [{ delta: { content: 'Answer' } }] }, 'down'],
    ] as const) {
      telemetry.mockClear();
      mockCreate.mockResolvedValue((async function* () { yield chunk; })());
      const result = await new OpenRouterConnector().callAgent(messages, { stream: true });
      expect(await consume(result.stream)).toEqual([chunk]);
      expect(telemetry.mock.calls[0][1]).toBe(expected);
    }
    expect(billing).not.toHaveBeenCalled();
  });

  it('settles cancelled stream usage without treating cancellation as successful generation', async () => {
    mockCreate.mockResolvedValue((async function* () {
      yield { id: 'generation-cancel', choices: [{ delta: { content: 'First' } }], usage: { cost: 0.01 } };
      yield { choices: [{ delta: { content: 'Second' } }] };
    })());
    const result = await new OpenRouterConnector().callAgent(messages, { stream: true, siteId: 'site-a' });
    for await (const _chunk of result.stream) break;
    expect(billing).toHaveBeenCalledTimes(1);
    expect(telemetry).not.toHaveBeenCalled();
  });

  it('propagates mid-stream provider failure and emits only down even after output', async () => {
    const error = new Error(synthetic());
    mockCreate.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'Partial' } }], usage: { cost: 0.01 } };
      throw error;
    })());
    const result = await new OpenRouterConnector().callAgent(messages, { stream: true, siteId: 'site-a' });
    await expect(consume(result.stream)).rejects.toBe(error);
    expect(billing).toHaveBeenCalledTimes(1);
    expect(telemetry.mock.calls.map(call => call[1])).toEqual(['down']);
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain(error.message);
  });

  it('preserves provider rejection and accepted error billing despite telemetry failure', async () => {
    const secret = synthetic();
    const error = Object.assign(new Error(secret), { status: 503 });
    telemetry.mockRejectedValue(new Error(synthetic()));
    mockCreate.mockRejectedValueOnce(error);
    await expect(new OpenRouterConnector().callAgent(messages)).rejects.toBe(error);
    mockCreate.mockResolvedValueOnce({ id: 'generation-error', usage: { cost: 0.01 }, error: { message: secret } });
    await expect(new OpenRouterConnector().callAgent(messages, { siteId: 'site-a' })).rejects.toThrow(secret);
    expect(billing).toHaveBeenCalledTimes(1);
    expect(telemetry.mock.calls.map(call => call[1])).toEqual(['down', 'down']);
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain(secret);
  });
});

describe('transcription writer observes only its deployment', () => {
  it('does not let another Azure account verify the current platform deployment', async () => {
    configureAudio();
    const customKey = synthetic();
    const customEnv = { ...process.env, MICROSOFT_AZURE_OPENAI_API_KEY: customKey };
    jest.mocked(global.fetch).mockResolvedValueOnce(Response.json({ text: 'Transcript' }));
    expect((await transcribeAudioBuffer({ buffer: Buffer.from('audio') }, customEnv)).success).toBe(true);
    jest.mocked(global.fetch).mockResolvedValueOnce(Response.json({}, { status: 503 }));
    expect((await transcribeAudioBuffer({ buffer: Buffer.from('audio') }, customEnv)).success).toBe(false);
    expect(telemetry).not.toHaveBeenCalled();
    jest.mocked(global.fetch).mockResolvedValueOnce(Response.json({ text: 'Transcript' }));
    expect((await transcribeAudioBuffer({ buffer: Buffer.from('audio') }, { ...process.env })).success).toBe(true);
    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain(customKey);
  });

  it('awaits validated transcription success and never writes a generic audio/TTS receipt', async () => {
    configureAudio();
    jest.mocked(global.fetch).mockResolvedValue(Response.json({ text: 'Transcript' }));
    let resolveReceipt!: () => void;
    telemetry.mockReturnValue(new Promise<void>(resolve => { resolveReceipt = resolve; }));
    let completed = false;
    const request = transcribeAudioBuffer({ buffer: Buffer.from('audio') }).then(result => { completed = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(telemetry).toHaveBeenCalledWith(getTranscriptionObservationKey('transcribe-a'), 'up', expect.any(String), expect.any(Number));
    resolveReceipt();
    expect(await request).toMatchObject({ success: true, text: 'Transcript', model: 'transcribe-a' });
    expect(telemetry).toHaveBeenCalledTimes(1);
  });

  it.each([Response.json({ text: ' ' }), Response.json({ error: {} }, { status: 503 })])('emits scoped down on invalid or failed transcription', async response => {
    configureAudio();
    jest.mocked(global.fetch).mockResolvedValue(response.clone());
    telemetry.mockRejectedValueOnce(new Error(synthetic()));
    expect(await transcribeAudioBuffer({ buffer: Buffer.from('audio') })).toMatchObject({ success: false });
    expect(telemetry).toHaveBeenCalledWith(getTranscriptionObservationKey('transcribe-a'), 'down', expect.any(String), expect.any(Number));
  });

  it('does not invent provider observations for missing config or empty local audio', async () => {
    expect((await transcribeAudioBuffer({ buffer: Buffer.from('audio') })).success).toBe(false);
    configureAudio();
    expect((await transcribeAudioBuffer({ buffer: Buffer.alloc(0) })).success).toBe(false);
    expect(telemetry).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});