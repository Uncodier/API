import { CreditService } from '@/lib/services/billing/CreditService';
/**
 * Assistant Protocol Wrapper for Generate Audio Tool
 * Formats the tool for OpenAI/assistant compatibility
 */

export interface GenerateAudioToolParams {
  text: string;
  provider?: 'vercel' | 'azure' | 'gemini';
  voice?: string;
  format?: 'mp3' | 'wav' | 'ogg';
  model?: string;
}

/**
 * Creates a generateAudio tool for OpenAI/assistant compatibility
 * @param site_id - The site ID to use for audio generation
 * @param instance_id - Optional instance ID to link generated audio to the instance
 * @returns Tool definition compatible with OpenAI function calling
 */
export function generateAudioTool(site_id: string, instance_id?: string) {
  return {
    name: 'generate_audio',
    description: 'Generate audio (Text-to-Speech) using AI. Returns a URL to the generated audio file.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to convert to speech.'
        },
        provider: {
          type: 'string',
          enum: ['gemini', 'vercel'],
          description: 'AI provider to use for generation. Gemini is the default and recommended.'
        },
        voice: {
          type: 'string',
          description: 'The voice to use for generation. E.g., "alloy", "echo", "fable", "onyx", "nova", "shimmer" (for OpenAI models).'
        },
        format: {
          type: 'string',
          enum: ['mp3', 'wav', 'ogg'],
          description: 'The audio format. Defaults to mp3.'
        },
        model: {
          type: 'string',
          description: 'The TTS model to use. E.g., "gpt-4o-mini-tts" or "tts-1".'
        }
      },
      required: ['text']
    },
    execute: async (args: GenerateAudioToolParams) => {
      try {
        console.log(`[GenerateAudioTool] 🎙️ Executing audio generation`);
        if (site_id) {
          // Assuming 0.1 credits per generation for TTS, same as image for simplicity unless defined otherwise
          const requiredCredits = CreditService.PRICING.IMAGE_GENERATION;
          const hasCredits = await CreditService.validateCredits(site_id, requiredCredits);
          if (!hasCredits) {
            throw new Error('Insufficient credits for audio generation');
          }
          await CreditService.deductCredits(site_id, requiredCredits, 'audio_generation', `Audio generation (TTS)`, { text_length: args.text.length });
        }

        console.log(`[GenerateAudioTool] 📝 Text: ${args.text.substring(0, 100)}...`);
        console.log(`[GenerateAudioTool] 🏢 Site ID: ${site_id}`);
        console.log(`[GenerateAudioTool] 🤖 Provider: ${args.provider || 'gemini'}`);

        // Validate required parameters
        if (!args.text || typeof args.text !== 'string') {
          return {
            success: false,
            error: 'text is required and must be a string',
            provider: 'none',
          };
        }

        const apiUrl = `${process.env.NEXT_PUBLIC_API_SERVER_URL || 'http://localhost:3000'}/api/ai/audio`;
        
        const requestBody = {
          text: args.text,
          provider: args.provider || 'gemini',
          voice: args.voice,
          format: args.format,
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
        
        // The API returns the raw audio buffer. We need to upload it to storage to get a URL, 
        // similar to how ImageGenerationService does it implicitly.
        // Wait, ImageGenerationService handles the storage upload in the /api/ai/image endpoint or inside the service itself?
        // Let's check how audio route works: It returns `new NextResponse(audio, ...)` which is binary data.
        // Since we are inside the tool, we need to store it somewhere to give the LLM a URL back.
        
        // We will read the blob and upload to supabase storage here.
        const audioBlob = await response.blob();
        
        const { supabaseAdmin } = await import('@/lib/database/supabase-client');
        
        const isGemini = (args.provider || 'gemini') === 'gemini';
        const fileExt = isGemini ? 'wav' : (args.format || 'mp3');
        const fileName = `generated_audio_${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
        const filePath = `${site_id}/${fileName}`;
        
        const { data: uploadData, error: uploadError } = await supabaseAdmin
          .storage
          .from('assets')
          .upload(filePath, audioBlob, {
            contentType: `audio/${fileExt === 'mp3' ? 'mpeg' : fileExt}`
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
          } catch (assetErr) {
            console.error(`[GenerateAudioTool] ⚠️ Failed to save to instance_assets:`, assetErr);
          }
        }

        console.log(`[GenerateAudioTool] ✅ Audio generation successful. URL: ${publicUrl}`);

        return {
          success: true,
          provider: args.provider || 'gemini',
          audio_url: publicUrl,
          mimeType: `audio/${fileExt === 'mp3' ? 'mpeg' : fileExt === 'wav' ? 'wav' : fileExt}`,
          metadata: {
            format: fileExt,
            voice: args.voice,
            generated_at: new Date().toISOString()
          },
          message: `Successfully generated audio using ${args.provider || 'gemini'}. Audio is saved and ready to use. URL: ${publicUrl}`
        };

      } catch (error: any) {
        console.error(`[GenerateAudioTool] ❌ Unexpected error:`, error);
        throw error;
      }
    }
  };
}
