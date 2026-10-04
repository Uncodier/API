import { CreditService } from '@/lib/services/billing/CreditService';
import { validateSpeechOptions, ttsMimeType, TTSProvider, TTSAudioFormat } from '@/lib/services/ai/tts-service';
import { TTS_VOICES, TTS_LANGUAGES } from '@/lib/services/ai/speech-options';
/**
 * Assistant Protocol Wrapper for Generate Audio Tool
 * Formats the tool for OpenAI/assistant compatibility
 */

export interface GenerateAudioToolParams {
  text: string;
  provider?: TTSProvider;
  voice?: string;
  language?: string;
  format?: TTSAudioFormat;
  model?: string;
}

interface GenerateAudioToolOptions {
  forceWhatsAppCompatible?: boolean;
}

/**
 * Creates a generateAudio tool for OpenAI/assistant compatibility
 * @param site_id - The site ID to use for audio generation
 * @param instance_id - Optional instance ID to link generated audio to the instance
 * @returns Tool definition compatible with OpenAI function calling
 */
export function generateAudioTool(
  site_id: string,
  instance_id?: string,
  options: GenerateAudioToolOptions = {}
) {
  return {
    name: 'generate_audio',
    description: 'Convert written text into speech or a voiceover through Azure directly. Choose a listed voice and language to suit the request unless the user selected them. Write the spoken text in the selected language before calling this tool; Azure detects language from that text and does not translate it. Auto leaves the choice to the request/context (voice falls back to the configured voice if omitted). Returns a URL to the generated audio file. This is speech synthesis, not a music-generation tool.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to convert to speech.'
        },
        provider: {
          type: 'string',
          enum: ['azure'],
          description: 'Azure direct is the only supported speech provider; normally omit this field.'
        },
        voice: {
          type: 'string',
          enum: ['auto', ...TTS_VOICES],
          default: 'auto',
          description: 'Select an Azure multilingual voice: alloy, echo, fable, onyx, nova or shimmer. Honor an explicit user choice; otherwise choose one appropriate for the request. Auto or omission uses the configured voice if no choice is made.'
        },
        language: {
          type: 'string',
          enum: ['auto', ...TTS_LANGUAGES],
          default: 'auto',
          description: 'Spoken text language (ISO 639-1). Honor the user selection or infer it from the request/context for auto. Write or translate the text into this language BEFORE calling the tool; synthesis itself does not translate text or force an accent.'
        },
        format: {
          type: 'string',
          enum: ['mp3', 'pcm', 'wav', 'opus', 'aac', 'flac'],
          description: 'The audio format. Defaults to mp3.'
        },
        model: {
          type: 'string',
          description: 'Optional Azure speech deployment name, not a qualified provider/model ID. Omit to use the configured deployment.'
        }
      },
      required: ['text']
    },
    execute: async (args: GenerateAudioToolParams) => {
      try {
        if (!args.text || typeof args.text !== 'string') {
          return { success: false, error: 'text is required and must be a string', provider: 'none' };
        }
        // WhatsApp constrains the container, not the provider/account or model.
        const speechOptions = validateSpeechOptions({
          text: args.text,
          provider: args.provider,
          voice: args.voice,
          language: args.language,
          format: options.forceWhatsAppCompatible ? 'mp3' : args.format,
          model: args.model,
        });
        const { provider, format } = speechOptions;
        
        console.log(`[GenerateAudioTool] 🎙️ Executing audio generation`);
        if (site_id) {
          // Estimate duration based on text length (approx 1000 chars per minute)
          const estimatedMinutes = args.text.length / 1000;
          const requiredCredits = Math.max(0.01, estimatedMinutes * CreditService.PRICING.AUDIO_GENERATION_MINUTE);
          const hasCredits = await CreditService.validateCredits(site_id, requiredCredits);
          if (!hasCredits) {
            throw new Error('Insufficient credits for audio generation');
          }
          await CreditService.deductCredits(site_id, requiredCredits, 'audio_generation', `Audio generation (TTS)`, { text_length: args.text.length });
        }

        console.log(`[GenerateAudioTool] 📝 Text: ${args.text.substring(0, 100)}...`);
        console.log(`[GenerateAudioTool] 🏢 Site ID: ${site_id}`);
        console.log(`[GenerateAudioTool] 🤖 Provider: ${provider}`);

        const apiUrl = `${process.env.NEXT_PUBLIC_API_SERVER_URL || 'http://localhost:3000'}/api/ai/audio`;
        
        const requestBody = {
          text: args.text,
          provider: provider,
          voice: speechOptions.voice,
          ...(speechOptions.language ? { language: speechOptions.language } : {}),
          format,
          model: speechOptions.deployment
        };

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.SERVICE_API_KEY || '',
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          console.error(`[GenerateAudioTool] ❌ Response not OK: ${errorText.substring(0, 200)}`);
          throw new Error(`Audio generation failed: ${response.status} ${errorText}`);
        }
        
        // The audio API returns bytes; store them to give the tool a media URL.
        const audioBlob = await response.blob();
        
        const { supabaseAdmin } = await import('@/lib/database/supabase-client');
        const { createInstanceLogCore } = await import('@/lib/tools/instance-log-core');
        
        const fileExt = format;
        const mimeType = ttsMimeType(format);
        const fileName = `generated_audio_${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
        const filePath = `${site_id}/${fileName}`;
        
        const { data: uploadData, error: uploadError } = await supabaseAdmin
          .storage
          .from('assets')
          .upload(filePath, audioBlob, {
            contentType: mimeType
          });
          
        if (uploadError) {
          throw new Error(`Failed to upload generated audio: ${uploadError.message}`);
        }
        
        const { data: { publicUrl } } = supabaseAdmin
          .storage
          .from('assets')
          .getPublicUrl(filePath);

        // Optional: Save to instance_assets if instance_id is provided
        if (instance_id) {
          try {
            await supabaseAdmin.from('instance_assets').insert({
              instance_id: instance_id,
              asset_url: publicUrl,
              asset_type: 'audio',
              name: fileName,
              source: 'generated'
            });
            
            await createInstanceLogCore({
              site_id,
              instance_id,
              log_type: 'agent_action',
              level: 'info',
              message: `Audio generated successfully: ${publicUrl}`,
              details: {
                provider: provider,
                audio_url: publicUrl,
                text: args.text,
                type: 'media_delivery',
                media_type: 'audio'
              }
            });
          } catch (assetErr) {
            console.error(`[GenerateAudioTool] ⚠️ Failed to log media delivery:`, assetErr);
          }
        }

        console.log(`[GenerateAudioTool] ✅ Audio generation successful. URL: ${publicUrl}`);

        return {
          success: true,
          provider: provider,
          audio_url: publicUrl,
          mimeType,
          metadata: {
            format: fileExt,
            voice: speechOptions.voice,
            language: speechOptions.language ?? 'auto',
            generated_at: new Date().toISOString()
          },
          message: `Successfully generated audio using ${provider}. Audio is saved and ready to use. URL: ${publicUrl}`
        };

      } catch (error: any) {
        console.error(`[GenerateAudioTool] ❌ Unexpected error:`, error);
        throw error;
      }
    }
  };
}
