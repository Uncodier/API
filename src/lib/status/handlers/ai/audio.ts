import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { checkTranscriptionProvider, checkTtsProvider } from '@/lib/status/handlers/ai/provider-probes';

export const aiAudioHandler: SystemHealthHandler = {
  systemKey: 'ai_audio',
  label: 'AI Audio (/api/ai/audio)',
  probePath: '/api/ai/audio',
  async runCheck() {
    const start = Date.now();
    const tts = checkTtsProvider();
    const transcription = checkTranscriptionProvider();
    const providers = { tts: tts.result, transcription: transcription.result };
    const configured = tts.result.configured || transcription.result.configured;
    const { status, degradedReasons } = evaluateAiProviders(providers, ['tts', 'transcription']);
    const latencyMs = Date.now() - start;

    return buildHealthResponse({
      systemKey: 'ai_audio',
      label: 'AI Audio (/api/ai/audio)',
      status: configured ? status : 'skipped',
      latencyMs,
      summary: configured ? 'Audio configuration checked; generation not probed' : 'Audio AI not configured',
      checks: {
        providers,
        ttsProvider: tts.provider,
        transcriptionProvider: transcription.provider,
        verification: 'configuration',
      },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai/audio',
    });
  },
};
