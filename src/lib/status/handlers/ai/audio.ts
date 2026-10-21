import {
  buildHealthResponse,
  evaluateAiProviders,
  type SystemHealthHandler,
} from '@/lib/status/types';
import { checkTranscriptionProvider, checkTtsProvider } from '@/lib/status/handlers/ai/provider-probes';
import { getTranscriptionObservationKey, getTtsObservationKey, readPassiveProviderObservation } from './passive-probes';

export const aiAudioHandler: SystemHealthHandler = {
  systemKey: 'ai_audio',
  label: 'AI Audio (/api/ai/audio)',
  probePath: '/api/ai/audio',
  async runCheck() {
    const start = Date.now();
    const tts = checkTtsProvider();
    const transcription = checkTranscriptionProvider();
    const [ttsResult, transcriptionResult] = await Promise.all([
      readPassiveProviderObservation(tts.result, getTtsObservationKey(tts.result.model)),
      readPassiveProviderObservation(transcription.result, getTranscriptionObservationKey(transcription.result.model)),
    ]);
    const providers = { tts: ttsResult, transcription: transcriptionResult };
    const configured = tts.result.configured || transcription.result.configured;
    const { degradedReasons } = evaluateAiProviders(providers, ['tts', 'transcription']);
    const observed = Object.values(providers).filter(p => p.verification === 'passive');
    const observedFailure = observed.some(p => !p.observedHealthy);
    const verification = observed.length === 2 ? 'passive' : observed.length ? 'partial' : 'configuration';
    const status = observedFailure ? 'down' : observed.length === 2 ? 'up' : observed.length ? 'degraded' : 'skipped';
    const latencyMs = Date.now() - start;

    return buildHealthResponse({
      systemKey: 'ai_audio',
      label: 'AI Audio (/api/ai/audio)',
      status: configured ? status : 'skipped',
      latencyMs,
      summary: observedFailure ? 'Audio: recent capability request failed'
        : verification === 'passive' ? 'Audio: recent transcription and TTS requests completed successfully'
          : verification === 'partial' ? 'Audio: partial recent evidence; transcription or TTS remains unverified'
            : configured ? 'Audio configuration checked; generation unverified' : 'Audio AI not configured',
      checks: {
        providers,
        ttsProvider: tts.provider,
        transcriptionProvider: transcription.provider,
        verification,
        observedFailure,
      },
      degradedReasons: degradedReasons.length ? degradedReasons : undefined,
      probePath: '/api/ai/audio',
    });
  },
};
