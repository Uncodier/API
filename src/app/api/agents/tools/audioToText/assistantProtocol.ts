import { CreditService } from '@/lib/services/billing/CreditService';
import { fetchAudioBuffer, transcribeAudioBuffer } from '@/lib/services/ai/transcribeAudio';

export interface AudioToTextToolParams {
  audio_url: string;
}

export function audioToTextTool(site_id?: string) {
  return {
    name: 'audio_to_text',
    description: 'Converts an audio file from a given URL to text using AI. Supported formats: mp3, mp4, mpeg, mpga, m4a, wav, or webm. Use this to transcribe voice notes, audio files, or extract text from videos.',
    parameters: {
      type: 'object',
      properties: {
        audio_url: {
          type: 'string',
          description: 'The valid public URL of the audio file to transcribe.'
        }
      },
      required: ['audio_url']
    },
    execute: async (args: AudioToTextToolParams) => {
      try {
        console.log(`[AudioToTextTool] Fetching audio from: ${args.audio_url}`);

        if (site_id) {
          const requiredCredits = CreditService.PRICING.AUDIO_TRANSCRIPTION;
          const hasCredits = await CreditService.validateCredits(site_id, requiredCredits);
          if (!hasCredits) {
            throw new Error('Insufficient credits for audio transcription');
          }
          await CreditService.deductCredits(site_id, requiredCredits, 'audio_transcription', 'Audio transcription via AI', { audio_url: args.audio_url });
        }

        const { buffer, contentType } = await fetchAudioBuffer(args.audio_url);
        const result = await transcribeAudioBuffer({ buffer, contentType });

        if (!result.success || !result.text) {
          throw new Error(result.error || 'Unknown error occurred during transcription');
        }

        return {
          success: true,
          text: result.text
        };
      } catch (error: any) {
        console.error(`[AudioToTextTool] Error:`, error);
        return {
          success: false,
          error: error.message || 'Unknown error occurred during transcription'
        };
      }
    }
  };
}
