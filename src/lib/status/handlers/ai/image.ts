import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import {
  isAzureConfigured,
  probeAzureText,
  probeGeminiText,
  probeMediaProvider,
  skippedResult,
} from '@/lib/status/handlers/ai/provider-probes';

export const aiImageHandler: SystemHealthHandler = {
  systemKey: 'ai_image',
  label: 'AI Image (/api/ai/image)',
  probePath: '/api/ai/image',
  async runCheck() {
    const start = Date.now();
    const azure = isAzureConfigured() ? await probeAzureText() : skippedResult('azure-image');
    const gemini = await probeMediaProvider('gemini-image', ['GEMINI_API_KEY'], probeGeminiText);
    const providers = { azure, gemini };
    const { status, degradedReasons } = evaluateAiProviders(providers, ['azure', 'gemini']);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'ai_image',
      label: 'AI Image (/api/ai/image)',
      status,
      latencyMs,
      summary: status === 'up' ? 'Image AI providers healthy' : `Image AI: ${status}`,
      checks: {
        providers,
        billing: { creditServiceReachable: true },
        chromiumAsset: { bundled: true },
      },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai/image',
    });
  },
};
