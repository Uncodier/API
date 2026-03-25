import { z } from 'zod';
import OpenAI from 'openai';
import { CreditService } from '@/lib/services/billing/CreditService';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

        const headers = new Headers();
        
        // Si la URL es de Twilio, necesitamos autenticarnos
        if (args.audio_url.includes('api.twilio.com')) {
           const accountSid = process.env.GEAR_TWILIO_ACCOUNT_SID;
           const authToken = process.env.GEAR_TWILIO_AUTH_TOKEN;
           if (accountSid && authToken) {
              headers.set('Authorization', `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`);
           }
        }

        let response = await fetch(args.audio_url, { headers, redirect: 'manual' });
        
        // Manejar la redirección de Twilio a S3
        if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
           const redirectUrl = response.headers.get('location')!;
           response = await fetch(redirectUrl);
        }

        if (!response.ok) {
          throw new Error(`Failed to fetch audio: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentType = response.headers.get('content-type') || 'audio/mp3';

        let transcriptionText = '';
        let success = false;
        let lastError: any = null;

        // Try Gemini 1.5 Pro first if available (supports native audio transcription)
        if (process.env.GEMINI_API_KEY && !success) {
          try {
            console.log(`[AudioToTextTool] Attempting transcription via Gemini...`);
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
            
            const result = await model.generateContent([
              "Please transcribe this audio exactly as spoken, without adding any commentary or extra text.",
              {
                inlineData: {
                  mimeType: contentType,
                  data: buffer.toString("base64")
                }
              }
            ]);
            
            transcriptionText = result.response.text();
            success = true;
            console.log(`[AudioToTextTool] Gemini transcription successful.`);
          } catch (err: any) {
            console.warn(`[AudioToTextTool] Gemini failed: ${err.message}`);
            lastError = err;
          }
        }

        // Fallback to OpenAI Direct or Portkey
        if (!success) {
          try {
            // Require Portkey dynamically to avoid unused imports
            const { Portkey } = require('portkey-ai');
            
            const directApiKey = process.env.OPENAI_API_KEY;
            const portkeyApiKey = process.env.PORTKEY_API_KEY;
            const baseURL = 'https://api.portkey.ai/v1'; // Default Portkey URL
            const virtualKey = process.env.AZURE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
            
            // Necesitamos asegurarnos de que la extensión sea válida para Whisper.
            // Whisper soporta: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg
            let fileExt = 'mp3';
            const contentTypeLower = contentType.toLowerCase();
            if (contentTypeLower.includes('ogg')) fileExt = 'ogg';
            else if (contentTypeLower.includes('wav')) fileExt = 'wav';
            else if (contentTypeLower.includes('webm')) fileExt = 'webm';
            else if (contentTypeLower.includes('mp4')) fileExt = 'mp4';
            else if (contentTypeLower.includes('m4a')) fileExt = 'm4a';

            const file = await OpenAI.toFile(buffer, `audio.${fileExt}`, { type: contentType });
            
            // 1. Direct OpenAI First (como en assistant)
            if (directApiKey && !success) {
               try {
                  console.log(`[AudioToTextTool] Attempting direct transcription via OpenAI Whisper...`);
                  const directOpenai = new OpenAI({ apiKey: directApiKey });
                  const transcription = await directOpenai.audio.transcriptions.create({
                    file: file,
                    model: 'whisper-1',
                  });
                  if (transcription && transcription.text) {
                     transcriptionText = transcription.text;
                     success = true;
                     console.log(`[AudioToTextTool] Direct OpenAI Whisper transcription successful.`);
                  }
               } catch (directErr: any) {
                  console.warn(`[AudioToTextTool] Direct OpenAI failed: ${directErr.message}`);
                  lastError = directErr;
               }
            }
            
            // 2. Fallback to Portkey
            if (!success && portkeyApiKey) {
               console.log(`[AudioToTextTool] Attempting transcription via Portkey OpenAI Whisper...`);
               const portkeyOptions: any = {
                 apiKey: portkeyApiKey,
                 baseURL,
                 provider: 'openai',
               };
               
               if (virtualKey) {
                 portkeyOptions.virtualKey = virtualKey;
               }

               const portkey = new Portkey(portkeyOptions);
               try {
                 const transcription = await portkey.audio.transcriptions.create({
                   file: file,
                   model: 'whisper-1',
                 });
                 if (transcription && transcription.text) {
                    transcriptionText = transcription.text;
                    success = true;
                    console.log(`[AudioToTextTool] Portkey OpenAI Whisper transcription successful.`);
                 }
               } catch (portkeyErr: any) {
                  console.warn(`[AudioToTextTool] Portkey OpenAI failed: ${portkeyErr.message}`);
                  lastError = portkeyErr;
               }
            }
          } catch (err: any) {
            console.warn(`[AudioToTextTool] OpenAI/Portkey error: ${err.message}`);
            lastError = err;
          }
        }

        if (!success) {
          throw new Error(`All audio transcription providers failed. Last error: ${lastError?.message}`);
        }
        
        return {
          success: true,
          text: transcriptionText
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
