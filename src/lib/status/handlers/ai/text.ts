import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { probeOpenRouterText } from '@/lib/status/handlers/ai/provider-probes';

export const aiTextHandler: SystemHealthHandler = {
  systemKey: 'ai_text',
  label: 'AI Text (/api/ai/text)',
  probePath: '/api/ai/text',
  async runCheck() {
    const start = Date.now();
    const providers = { openrouter: await probeOpenRouterText() };
    const probe = providers.openrouter;
    const { status, degradedReasons } = evaluateAiProviders(providers, ['openrouter']);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'ai_text',
      label: 'AI Text (/api/ai/text)',
      status,
      latencyMs,
      summary:
        probe.verification === 'passive'
          ? `OpenRouter text: recent request ${probe.observedHealthy ? 'completed successfully' : 'failed'}`
          : status === 'up'
          ? 'OpenRouter text inference healthy'
          : status === 'skipped' ? 'Text AI configured; generation unverified'
            : `Text AI: ${degradedReasons.join(', ') || status}`,
      checks: { providers, modes: ['chat'], verification: probe.verification ?? 'configuration',
        observedAt: probe.observedAt, observedFailure: probe.verification === 'passive' && !probe.observedHealthy },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai/text',
    });
  },
};
