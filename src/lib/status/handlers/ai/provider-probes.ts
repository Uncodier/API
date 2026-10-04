import {
  createOpenRouterClient,
  getOpenRouterChatModel,
  getOpenRouterTtsModel,
  isOpenRouterReasoningModel,
  resolveOpenRouterModel,
} from '@/lib/services/ai/openrouter';
import type { ProviderProbeResult } from '@/lib/status/types';
import { isAiProbeEnabled } from '@/lib/status/types';
import { getAzureImageConfig } from '@/lib/services/image/azure-image-config';

const PROBE_TIMEOUT_MS = 15_000;

function getEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function hasEnv(...names: string[]): boolean {
  return names.every((name) => !!getEnv(name));
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

export async function probeOpenRouterText(): Promise<ProviderProbeResult> {
  const model = getOpenRouterChatModel();
  if (!getEnv('OPENROUTER_API_KEY')) return skippedResult(model);
  if (!isAiProbeEnabled()) {
    return {
      ...configurationResult(model, true),
      errorCode: 'PROBE_DISABLED',
      errorMessage: 'Live probes require STATUS_AI_PROBE_ENABLED=true',
    };
  }

  const start = Date.now();
  try {
    const client = createOpenRouterClient({ timeout: PROBE_TIMEOUT_MS, maxRetries: 0 });
    await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      ...(isOpenRouterReasoningModel(model) ? { max_completion_tokens: 100 } : { max_tokens: 10 }),
    });
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

/** Readiness only: a text completion does not verify image/video/audio generation. */
export function checkOpenRouterMedia(
  capability: 'video' | 'tts' | 'transcription',
): ProviderProbeResult {
  const model = getEnv(`OPENROUTER_${capability.toUpperCase()}_MODEL`)
    || (capability === 'tts' ? getOpenRouterTtsModel() : undefined);
  return configurationResult(
    model ? resolveOpenRouterModel(model) : `${capability}-model-not-configured`,
    !!model && ((capability !== 'tts' && capability !== 'transcription') || model.includes('/'))
      && hasEnv('OPENROUTER_API_KEY'),
  );
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
  return { provider: 'openrouter', result: checkOpenRouterMedia('tts') };
}

export function checkTranscriptionProvider(): { provider: string; result: ProviderProbeResult } {
  return { provider: 'openrouter', result: checkOpenRouterMedia('transcription') };
}
