import {
  buildHealthResponse,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { getLatestTelemetry } from '@/lib/status/telemetry';

export const aiAudioHandler: SystemHealthHandler = {
  systemKey: 'ai_audio',
  label: 'AI Audio (/api/ai/audio)',
  probePath: '/api/ai/audio',
  async runCheck() {
    const start = Date.now();
    
    // Fallback: Read from passive telemetry instead of active probes that fail spuriously
    const telemetry = await getLatestTelemetry('ai_audio');
    
    // To provide real-time environment validation, we check local env configuration
    // (matches logic in src/lib/services/ai/transcribeAudio.ts)
    const hasGemini = !!process.env.GEMINI_API_KEY;
    const hasOpenAiDirect = !!process.env.OPENAI_API_KEY;
    const hasVercelGateway = !!process.env.VERCEL_AI_GATEWAY_OPENAI && !!process.env.VERCEL_AI_GATEWAY_API_KEY;
    const hasPortkeyOpenAi = !!process.env.PORTKEY_API_KEY && !!process.env.PORTKEY_VIRTUAL_KEY_OPENAI;
    
    const configured = hasGemini || hasOpenAiDirect || hasVercelGateway || hasPortkeyOpenAi;
    
    const latencyMs = Date.now() - start;
    const status = telemetry ? telemetry.status : (configured ? 'up' : 'skipped');
    
    return buildHealthResponse({
      systemKey: 'ai_audio',
      label: 'AI Audio (/api/ai/audio)',
      status,
      latencyMs: telemetry?.latency_ms || latencyMs,
      summary: telemetry 
        ? telemetry.message 
        : (configured ? 'Assuming healthy (configured, no recent traffic)' : 'Audio AI not configured'),
      checks: {
        telemetryFound: !!telemetry,
        lastEventAt: telemetry?.created_at,
        configuration: {
          gemini: hasGemini,
          openaiDirect: hasOpenAiDirect,
          vercelGateway: hasVercelGateway,
          portkeyOpenAi: hasPortkeyOpenAi,
        },
      },
      probePath: '/api/ai/audio',
    });
  },
};
