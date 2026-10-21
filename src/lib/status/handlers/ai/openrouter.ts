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
    const probe = providers.openrouter;
    const { status, degradedReasons } = evaluateAiProviders(providers, ['openrouter']);
    const latencyMs = Date.now() - start;

    return buildHealthResponse({
      systemKey: 'ai_portkey',
      label: 'AI OpenRouter (/api/ai)',
      status,
      latencyMs,
      summary: probe.verification === 'passive'
        ? `OpenRouter text: recent request ${probe.observedHealthy ? 'completed successfully' : 'failed'}`
        : status === 'up' ? 'OpenRouter text inference healthy'
          : status === 'skipped' ? 'OpenRouter text configured; generation unverified'
            : `OpenRouter: ${degradedReasons.join(', ')}`,
      checks: { providers, verification: probe.verification ?? 'configuration',
        observedAt: probe.observedAt, observedFailure: probe.verification === 'passive' && !probe.observedHealthy },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai',
    });
  },
};
