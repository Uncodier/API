import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { probeOpenRouterText } from '@/lib/status/handlers/ai/provider-probes';

export const aiOpenRouterHandler: SystemHealthHandler = {
  // Historical key is persisted in status/telemetry; changing it requires a DB migration.
  systemKey: 'ai_portkey',
  label: 'AI OpenRouter (/api/ai)',
  probePath: '/api/ai',
  async runCheck() {
    const start = Date.now();
    const providers = { openrouter: await probeOpenRouterText() };
    const { status, degradedReasons } = evaluateAiProviders(providers, ['openrouter']);
    const latencyMs = Date.now() - start;

    return buildHealthResponse({
      systemKey: 'ai_portkey',
      label: 'AI OpenRouter (/api/ai)',
      status,
      latencyMs,
      summary: status === 'up' ? 'OpenRouter text inference healthy' : `OpenRouter: ${degradedReasons.join(', ')}`,
      checks: { providers },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai',
    });
  },
};
