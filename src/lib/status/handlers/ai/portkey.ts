import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import {
  probePortkeyProvider,
} from '@/lib/status/handlers/ai/provider-probes';

export const aiPortkeyHandler: SystemHealthHandler = {
  systemKey: 'ai_portkey',
  label: 'AI Portkey (/api/ai)',
  probePath: '/api/ai',
  async runCheck() {
    const start = Date.now();
    const [openai, gemini] = await Promise.all([
      probePortkeyProvider('openai'),
      probePortkeyProvider('gemini'),
    ]);
    const providers = { openai, gemini };
    const { status, degradedReasons } = evaluateAiProviders(providers, ['openai']);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'ai_portkey',
      label: 'AI Portkey (/api/ai)',
      status,
      latencyMs,
      summary:
        status === 'up'
          ? 'All configured Portkey providers passed live probe'
          : `Portkey providers: ${degradedReasons.join(', ') || status}`,
      checks: { providers },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai',
    });
  },
};
