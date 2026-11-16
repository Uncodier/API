import {
  createOpenRouterClient,
  getOpenRouterChatModel,
  isOpenRouterReasoningModel,
} from '@/lib/services/ai/openrouter';
import type { ProviderProbeResult } from '@/lib/status/types';
import { isAiProbeEnabled } from '@/lib/status/types';
import { getAzureImageConfig } from '@/lib/services/image/azure-image-config';
import { getAzureTranscriptionConfig } from '@/lib/services/ai/azure-transcription-config';
import { getAzureTtsConfig } from '@/lib/services/ai/azure-tts-config';
import { getGeminiVideoModel } from '@/app/api/ai/video/provider-gemini';
import { getTextObservationKey, readPassiveProviderObservation } from './passive-probes';

const PROBE_TIMEOUT_MS = 15_000;

function getEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

// Provider errors can contain credentials, URLs and request bodies. Never publish them.
function mapProbeError(err: unknown): { errorCode: string; errorMessage: string } {
  const message = err instanceof Error ? err.message : '';
  const status = err && typeof err === 'object' && 'status' in err ? err.status : undefined;
  if (/timeout|timed out/i.test(message)) {
    return { errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'Probe timed out' };
  }
  if (status === 401 || status === 403 || /\b40[13]\b|unauthorized|invalid.*key/i.test(message)) {
    return { errorCode: 'AUTH_FAILED', errorMessage: 'Authentication failed' };
  }
  if (status === 429 || /\b429\b|rate limit/i.test(message)) {
    return { errorCode: 'QUOTA_EXCEEDED', errorMessage: 'Rate limited' };
  }
  return { errorCode: 'PROVIDER_ERROR', errorMessage: 'Provider probe failed' };
}

export function skippedResult(model: string): ProviderProbeResult {
  return { configured: false, liveProbe: false, latencyMs: 0, model, skipped: true };
}

function configurationResult(model: string, configured: boolean): ProviderProbeResult {
  if (!configured) return skippedResult(model);
  return {
    configured: true,
    liveProbe: false,
    latencyMs: 0,
    model,
    verification: 'configuration',
  };
}

export async function probeOpenRouterText(options: { passiveOnly?: boolean } = {}): Promise<ProviderProbeResult> {
  const model = getOpenRouterChatModel();
  if (!getEnv('OPENROUTER_API_KEY')) return skippedResult(model);
  if (options.passiveOnly || !isAiProbeEnabled()) {
    return readPassiveProviderObservation({
      ...configurationResult(model, true),
      errorCode: 'PROBE_DISABLED',
      errorMessage: 'Live probes require STATUS_AI_PROBE_ENABLED=true',
    }, getTextObservationKey(model));
  }

  const start = Date.now();
  try {
    const client = createOpenRouterClient({ timeout: PROBE_TIMEOUT_MS, maxRetries: 0 });
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      ...(isOpenRouterReasoningModel(model) ? { max_completion_tokens: 100 } : { max_tokens: 10 }),
    });
    if (!response.choices?.some(choice => typeof choice.message?.content === 'string' && choice.message.content.trim())) {
      return { configured: true, liveProbe: false, verification: 'inference', latencyMs: Date.now() - start,
        model, errorCode: 'INVALID_RESPONSE', errorMessage: 'Probe returned no generated text' };
    }
    return { configured: true, liveProbe: true, verification: 'inference', latencyMs: Date.now() - start, model };
  } catch (err) {
    return {
      configured: true,
      liveProbe: false,
      verification: 'inference',
      latencyMs: Date.now() - start,
      model,
      ...mapProbeError(err),
    };
  }
}

/** Configuration only: never infer availability, quality or billing from readiness. */
export function checkAzureImage(): ProviderProbeResult {
  try {
    const config = getAzureImageConfig();
    return configurationResult(config.deployment, true);
  } catch {
    return skippedResult('azure-image-not-configured');
  }
}

export function checkTtsProvider(): { provider: string; result: ProviderProbeResult } {
  try {
    const config = getAzureTtsConfig();
    return { provider: 'azure', result: configurationResult(config.deployment, true) };
  } catch {
    return { provider: 'azure', result: skippedResult('azure-tts-not-configured') };
  }
}

export function checkTranscriptionProvider(): { provider: string; result: ProviderProbeResult } {
  try {
    const config = getAzureTranscriptionConfig();
    return { provider: 'azure-direct', result: configurationResult(config.deployment, true) };
  } catch {
    return { provider: 'azure-direct', result: skippedResult('azure-transcription-not-configured') };
  }
}

/** Platform video readiness only; no paid generation in probes. */
export function checkGeminiVideo(): ProviderProbeResult {
  return configurationResult(getGeminiVideoModel(),
    !!(getEnv('GEMINI_API_KEY') || getEnv('GOOGLE_GENERATIVE_AI_API_KEY')));
}
