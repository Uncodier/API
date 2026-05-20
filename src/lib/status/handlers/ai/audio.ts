import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { probeAzureText, probeMediaProvider } from '@/lib/status/handlers/ai/provider-probes';

export const aiAudioHandler: SystemHealthHandler = {
  systemKey: 'ai_audio',
  label: 'AI Audio (/api/ai/audio)',
  probePath: '/api/ai/audio',
  async runCheck() {
    const start = Date.now();
    const azure = await probeMediaProvider(
      'azure-tts',
      ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY'],
      probeAzureText,
    );
    const providers = { azure };
    const { status, degradedReasons } = evaluateAiProviders(providers, ['azure']);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'ai_audio',
      label: 'AI Audio (/api/ai/audio)',
      status: azure.skipped ? 'skipped' : status,
      latencyMs,
      summary: azure.skipped ? 'Audio AI not configured' : `Audio AI: ${status}`,
      checks: { ttsProviders: providers, storageReachable: true },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai/audio',
    });
  },
};
