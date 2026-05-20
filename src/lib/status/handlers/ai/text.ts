import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import {
  probeAzureText,
  probeGeminiText,
  probeVercelGateway,
} from '@/lib/status/handlers/ai/provider-probes';

export const aiTextHandler: SystemHealthHandler = {
  systemKey: 'ai_text',
  label: 'AI Text (/api/ai/text)',
  probePath: '/api/ai/text',
  async runCheck() {
    const start = Date.now();
    const [azure, gemini, vercel] = await Promise.all([
      probeAzureText(),
      probeGeminiText(),
      probeVercelGateway(),
    ]);
    const providers = { azure, gemini, vercel };
    const { status, degradedReasons } = evaluateAiProviders(providers, ['azure']);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'ai_text',
      label: 'AI Text (/api/ai/text)',
      status,
      latencyMs,
      summary:
        status === 'up'
          ? 'Text AI providers healthy'
          : `Text AI: ${degradedReasons.join(', ') || status}`,
      checks: { providers, modes: ['chat'] },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai/text',
    });
  },
};
