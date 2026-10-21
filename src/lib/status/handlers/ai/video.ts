import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { checkOpenRouterMedia } from '@/lib/status/handlers/ai/provider-probes';
import { getVideoObservationKey, readPassiveProviderObservation } from './passive-probes';

export const aiVideoHandler: SystemHealthHandler = {
  systemKey: 'ai_video',
  label: 'AI Video (/api/ai/video)',
  probePath: '/api/ai/video',
  async runCheck() {
    const start = Date.now();
    const configured = checkOpenRouterMedia('video');
    const openrouter = await readPassiveProviderObservation(configured, getVideoObservationKey(configured.model));
    const providers = { openrouter };
    const { status, degradedReasons } = evaluateAiProviders(providers, ['openrouter']);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'ai_video',
      label: 'AI Video (/api/ai/video)',
      status: openrouter.skipped ? 'skipped' : openrouter.observedStatus === 'degraded' ? 'degraded' : status,
      latencyMs,
      summary: openrouter.verification === 'passive'
        ? openrouter.observedHealthy ? 'Video: recent generation, persistence and billing completed successfully'
          : 'Video: recent operation failed or completion is uncertain'
        : openrouter.skipped ? 'OpenRouter video not configured' : 'OpenRouter video configured; generation not probed',
      checks: { providers, verification: openrouter.verification === 'passive' ? 'passive' : 'configuration' },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai/video',
    });
  },
};
