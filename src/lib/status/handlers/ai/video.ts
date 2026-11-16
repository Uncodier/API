import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { checkGeminiVideo } from '@/lib/status/handlers/ai/provider-probes';
import { getVideoObservationKey, readPassiveProviderObservation } from './passive-probes';

export const aiVideoHandler: SystemHealthHandler = {
  systemKey: 'ai_video',
  label: 'AI Video (/api/ai/video)',
  probePath: '/api/ai/video',
  async runCheck() {
    const start = Date.now();
    const configured = checkGeminiVideo();
    const gemini = await readPassiveProviderObservation(configured, getVideoObservationKey(configured.model));
    const providers = { gemini };
    const { status, degradedReasons } = evaluateAiProviders(providers, ['gemini']);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'ai_video',
      label: 'AI Video (/api/ai/video)',
      status: gemini.skipped ? 'skipped' : gemini.observedStatus === 'degraded' ? 'degraded' : status,
      latencyMs,
      summary: gemini.verification === 'passive'
        ? gemini.observedHealthy ? 'Video: recent generation, persistence and billing completed successfully'
          : 'Video: recent operation failed or completion is uncertain'
        : gemini.skipped ? 'Gemini video not configured' : 'Gemini video configured; generation not probed',
      checks: { providers, verification: gemini.verification === 'passive' ? 'passive' : 'configuration' },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai/video',
    });
  },
};
