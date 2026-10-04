import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { checkAzureImage } from '@/lib/status/handlers/ai/provider-probes';

export const aiImageHandler: SystemHealthHandler = {
  systemKey: 'ai_image',
  label: 'AI Image (/api/ai/image)',
  probePath: '/api/ai/image',
  async runCheck() {
    const start = Date.now();
    const providers = { azure: checkAzureImage() };
    const { status, degradedReasons } = evaluateAiProviders(providers, ['azure']);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'ai_image',
      label: 'AI Image (/api/ai/image)',
      status,
      latencyMs,
      summary: providers.azure.configured
        ? 'Azure direct image configured; generation not probed'
        : 'Azure direct image not configured',
      checks: {
        providers,
        verification: 'configuration',
      },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai/image',
    });
  },
};
