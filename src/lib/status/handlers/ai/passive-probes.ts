import { createHash } from 'node:crypto';
import { getLatestTelemetry } from '@/lib/status/telemetry';
import type { ProviderProbeResult } from '@/lib/status/types';

export const AI_OBSERVATION_MAX_AGE_MS = 15 * 60 * 1000;

// Hash only the resolved model/deployment, never credentials or request content.
function modelKey(prefix: string, model: string): string {
  return `${prefix}_${createHash('sha256').update(model).digest('hex')}`;
}

export function getTextObservationKey(model: string): string {
  return modelKey('ai_text_openrouter', model);
}

export function getTranscriptionObservationKey(model: string): string {
  return modelKey('ai_audio_transcription_azure', model);
}

export function getTtsObservationKey(model: string): string {
  return modelKey('ai_audio_tts_azure', model);
}

export function getImageObservationKey(deployment: string): string {
  return modelKey('ai_image_azure', deployment);
}

export function getVideoObservationKey(model: string): string {
  return modelKey('ai_video_openrouter', model);
}

/** Read evidence from real requests only; configuration is still required. */
export async function readPassiveProviderObservation(
  result: ProviderProbeResult,
  key: string,
): Promise<ProviderProbeResult> {
  if (!result.configured || result.skipped) return result;
  try {
    const receipt = await getLatestTelemetry(key, AI_OBSERVATION_MAX_AGE_MS / 3_600_000);
    if (!receipt || !['up', 'down', 'degraded'].includes(receipt.status)) return result;
    const age = Date.now() - Date.parse(receipt.created_at);
    if (!Number.isFinite(age) || age < 0 || age > AI_OBSERVATION_MAX_AGE_MS) return result;
    const { errorCode: _code, errorMessage: _message, ...configuration } = result;
    return {
      ...configuration,
      liveProbe: false,
      verification: 'passive',
      observedHealthy: receipt.status === 'up',
      observedStatus: receipt.status as 'up' | 'down' | 'degraded',
      observedAt: receipt.created_at,
      latencyMs: Number.isFinite(receipt.latency_ms) ? Math.max(0, receipt.latency_ms) : 0,
      ...(receipt.status === 'up' ? {} : {
        errorCode: 'OBSERVED_PROVIDER_FAILURE',
        errorMessage: 'Recent request did not complete successfully',
      }),
    };
  } catch {
    // An unavailable evidence store means unverified, not successful or failed inference.
    return result;
  }
}