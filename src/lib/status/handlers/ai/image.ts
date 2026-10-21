import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { checkAzureImage } from '@/lib/status/handlers/ai/provider-probes';
import { getImageObservationKey, readPassiveProviderObservation } from './passive-probes';

export const aiImageHandler: SystemHealthHandler = {
  systemKey: 'ai_image',
  label: 'AI Image (/api/ai/image)',
  probePath: '/api/ai/image',
  async runCheck() {
    const start = Date.now();
    const configured = checkAzureImage();
    const azure = await readPassiveProviderObservation(configured, getImageObservationKey(configured.model));
    const providers = { azure };
    const { status, degradedReasons } = evaluateAiProviders(providers, ['azure']);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'ai_image',
      label: 'AI Image (/api/ai/image)',
      status: azure.observedStatus === 'degraded' ? 'degraded' : status,
      latencyMs,
      summary: azure.verification === 'passive'
        ? azure.observedHealthy ? 'Image: recent validated generation and persistence completed successfully'
          : 'Image: recent generation or persistence did not complete successfully'
        : azure.configured ? 'Azure direct image configured; generation not probed' : 'Azure direct image not configured',
      checks: {
        providers,
        verification: azure.verification === 'passive' ? 'passive' : 'configuration',
      },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai/image',
    });
  },
};
