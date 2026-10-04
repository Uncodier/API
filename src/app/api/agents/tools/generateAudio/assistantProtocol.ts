import { CreditService } from '@/lib/services/billing/CreditService';
import { resolveTTSProvider, ttsMimeType, TTSProvider, TTSAudioFormat } from '@/lib/services/ai/tts-service';
/**
 * Assistant Protocol Wrapper for Generate Audio Tool
 * Formats the tool for OpenAI/assistant compatibility
 */

export interface GenerateAudioToolParams {
  text: string;
  provider?: TTSProvider;
  voice?: string;
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
    description: 'Convert written text into speech or a voiceover through OpenRouter. Returns a URL to the generated audio file. This is speech synthesis, not a music-generation tool.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to convert to speech.'
        },
        provider: {
          type: 'string',
          enum: ['openrouter'],
          description: 'OpenRouter is the only supported gateway; normally omit this field.'
        },
        voice: {
          type: 'string',
          description: 'Optional voice supported by the selected speech model. Omit to use the server default Spanish voice.'
        },
        format: {
          type: 'string',
          enum: ['mp3', 'pcm'],
          description: 'The audio format. Defaults to mp3.'
        },
        model: {
          type: 'string',
          description: 'Optional qualified OpenRouter speech model ID. Omit to use the configured model. Supply a compatible voice when overriding the model.'
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
        const format = options.forceWhatsAppCompatible ? 'mp3' : args.format || 'mp3';
        const provider = resolveTTSProvider(args.provider);
        
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
          voice: args.voice,
          format,
          model: args.model
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
            voice: args.voice,
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
