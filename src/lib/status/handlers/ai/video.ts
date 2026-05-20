import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { probeGeminiText, probeMediaProvider } from '@/lib/status/handlers/ai/provider-probes';

export const aiVideoHandler: SystemHealthHandler = {
  systemKey: 'ai_video',
  label: 'AI Video (/api/ai/video)',
  probePath: '/api/ai/video',
  async runCheck() {
    const start = Date.now();
    const gemini = await probeMediaProvider('gemini-video', ['GEMINI_API_KEY'], probeGeminiText);
    const providers = { gemini };
    const { status, degradedReasons } = evaluateAiProviders(providers, ['gemini']);
    const latencyMs = Date.now() - start;
    return buildHealthResponse({
      systemKey: 'ai_video',
      label: 'AI Video (/api/ai/video)',
      status: gemini.skipped ? 'skipped' : status,
      latencyMs,
      summary: gemini.skipped ? 'Video AI not configured' : `Video AI: ${status}`,
      checks: { providers, maxDurationConfigured: true },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai/video',
    });
  },
};
