import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { checkOpenRouterMedia } from '@/lib/status/handlers/ai/provider-probes';

export const aiVideoHandler: SystemHealthHandler = {
  systemKey: 'ai_video',
  label: 'AI Video (/api/ai/video)',
  probePath: '/api/ai/video',
  async runCheck() {
    const start = Date.now();
    const openrouter = checkOpenRouterMedia('video');
    const providers = { openrouter };
    const { status, degradedReasons } = evaluateAiProviders(providers, ['openrouter']);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'ai_video',
      label: 'AI Video (/api/ai/video)',
      status: openrouter.skipped ? 'skipped' : status,
      latencyMs,
      summary: openrouter.skipped ? 'OpenRouter video not configured' : 'OpenRouter video configured; generation not probed',
      checks: { providers, verification: 'configuration' },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai/video',
    });
  },
};
