import { CreditService } from '@/lib/services/billing/CreditService';
import { prepareSpeechOptions, ttsMimeType, TTSProvider, TTSAudioFormat } from '@/lib/services/ai/tts-service';
import { TTS_VOICES } from '@/lib/services/ai/speech-options';
import { getExecutionRouting, getCustomerOperationKey, requiresPlatformInferenceCredits } from '@/lib/services/ai/customer-routing';
import { executionRoutingHeaders } from '@/lib/services/ai/customer-routing-http';
import { createHash, randomUUID } from 'node:crypto';
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
  const customerSpeech = getExecutionRouting(site_id)?.payer === 'customer';
  return {
    name: 'generate_audio',
    description: `Convert written text into speech or a voiceover through ${customerSpeech ? 'the pinned customer speech model' : 'Azure directly'}. Resolve spoken language in this order: explicit customer request, current customer conversation (including available audio transcripts), lead language preference, site language. Never infer customer language from HTTP Accept-Language or internal instructions. Preserve the requested regional wording in the text. Write the complete spoken text in that language BEFORE calling this tool; pass the resolved language, preserving a script, region or dialect specified by the customer or established by context. If only the base language is known, pass it; do not invent a region. Generate each continuous message in one call rather than synthesizing sentence fragments. Pass only intended spoken content, with natural punctuation, not markdown or language instructions. Honor an explicit voice selection; otherwise keep the previous conversation voice when known, or omit voice to use the configured voice. Returns a URL to the generated audio file. This is speech synthesis, not a music-generation tool.`,
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to convert to speech.'
        },
        provider: {
          type: 'string',
          enum: customerSpeech ? ['openrouter'] : ['azure'],
          description: customerSpeech ? 'The shared customer OpenRouter account; normally omit this field.' : 'Azure direct is the only supported speech provider; normally omit this field.'
        },
        voice: {
          type: 'string',
          enum: ['auto', ...TTS_VOICES],
          default: 'auto',
          description: 'Select a voice profile (mapped to an available local voice for regional Azure speech): alloy, echo, fable, onyx, nova or shimmer. Honor an explicit user choice; otherwise keep the previous conversation voice when known. Auto or omission uses the configured voice. Do not change voices simply because the language changes.'
        },
        language: {
          type: 'string',
          default: 'auto',
          description: customerSpeech ? 'Use a base language for text guidance. The pinned customer model cannot enforce a regional voice. Write the intended spoken text BEFORE calling the tool.' : 'Spoken language tag, e.g. fr, fr-CA, sr-Latn-RS or zh-CN-liaoning. Pass a specific locale only when supported by the request or context. Honor the user selection or infer it from the request/context for auto. Write or translate the text into this language BEFORE calling the tool; synthesis itself does not translate text.'
        },
        format: {
          type: 'string',
          enum: customerSpeech ? ['mp3', 'pcm'] : ['mp3', 'pcm', 'wav', 'opus', 'aac', 'flac'],
          description: 'The audio format. Defaults to mp3.'
        },
        model: {
          type: 'string',
          description: customerSpeech ? 'Omit to use the pinned customer speech model.' : 'Optional Azure speech deployment name for legacy synthesis. Omit for regional speech.'
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
        const speechOptions = await prepareSpeechOptions({
          text: args.text,
          provider: args.provider,
          voice: args.voice,
          language: args.language,
          format: options.forceWhatsAppCompatible ? 'mp3' : args.format,
          model: args.model,
        });
        const { provider, format } = speechOptions;
        
        console.log(`[GenerateAudioTool] 🎙️ Executing audio generation`);
        if (site_id && requiresPlatformInferenceCredits(site_id)) {
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
        console.log('[GenerateAudioTool] Speech selection', {
          language: speechOptions.language ?? 'auto',
          requested_language: args.language ?? 'auto',
          language_source: speechOptions.language ? 'tool_argument' : 'text_autodetection',
          voice: speechOptions.voice,
          model: speechOptions.deployment,
        });

        const apiUrl = `${process.env.NEXT_PUBLIC_API_SERVER_URL || 'http://localhost:3000'}/api/ai/audio`;
        
        // Let the API resolve the regional voice on its own host; a resolved
        // Neural voice is not a valid input profile or OpenAI deployment.
        const requestBody = {
          ...(getExecutionRouting(site_id) ? { site_id } : {}),
          text: args.text,
          provider: provider,
          voice: speechOptions.native ? args.voice : speechOptions.voice,
          ...(speechOptions.language ? { language: speechOptions.language } : {}),
          format,
          ...(!speechOptions.native && { model: provider === 'openrouter' ? args.model : speechOptions.deployment }),
        };

        const routing = getExecutionRouting(site_id);
        // Consume the host ordinal once; the signed ticket and durable dispatch
        // header must name the same operation, including long workflow IDs.
        const operationId = routing?.payer === 'customer'
          ? `speech:${createHash('sha256').update(getCustomerOperationKey() ?? randomUUID()).digest('hex')}` : undefined;
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.SERVICE_API_KEY || '',
            ...(operationId ? { 'Idempotency-Key': operationId } : {}),
            ...(routing ? await executionRoutingHeaders(routing, {
              path: '/api/ai/audio', operationId,
            }) : {}),
          },
          body: JSON.stringify(requestBody),
          redirect: 'error',
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          console.error(`[GenerateAudioTool] ❌ Response not OK: ${errorText.substring(0, 200)}`);
          throw new Error(`Audio generation failed: ${response.status} ${errorText}`);
        }
        
        // A stale or differently configured API must not deliver a different accent
        // while reporting the preflight selection. Never retry a billable request.
        if (speechOptions.native && (response.headers.get('X-TTS-Model') !== speechOptions.deployment
          || response.headers.get('X-TTS-Text-Language') !== speechOptions.language
          || response.headers.get('X-TTS-Voice') !== speechOptions.voice)) {
          await response.body?.cancel();
          throw new Error('Audio API did not confirm the selected regional voice');
        }
        // The audio API returns bytes; store them to give the tool a media URL.
        const audioBlob = await response.blob();
        const actualProvider = response.headers.get('X-TTS-Provider') ?? provider;
        
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
                provider: actualProvider,
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
          provider: actualProvider,
          audio_url: publicUrl,
          mimeType,
          metadata: {
            format: fileExt,
            voice: response.headers.get('X-TTS-Voice') ?? speechOptions.voice,
            language: response.headers.get('X-TTS-Text-Language') ?? speechOptions.language ?? 'auto',
            requested_language: args.language ?? 'auto',
            language_source: speechOptions.language ? 'tool_argument' : 'text_autodetection',
            model: response.headers.get('X-TTS-Model') ?? speechOptions.deployment,
            generated_at: new Date().toISOString()
          },
          message: `Successfully generated audio using ${actualProvider}. Audio is saved and ready to use. URL: ${publicUrl}`
        };

      } catch (error: any) {
        console.error(`[GenerateAudioTool] ❌ Unexpected error:`, error);
        throw error;
      }
    }
  };
}
