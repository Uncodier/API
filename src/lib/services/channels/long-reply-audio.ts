import { CreditService } from '@/lib/services/billing/CreditService';
import { synthesizeWithGemini, synthesizeWithVercel } from '@/lib/services/ai/tts-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export const AUDIO_REPLY_CHANNELS = ['whatsapp', 'telegram', 'messenger'];
export const LONG_REPLY_AUDIO_THRESHOLD = 400;
const TTS_MAX_CHARS = 4000;

export interface PrepareAudioParams {
  siteId: string;
  channel: string;
  text: string;
  existingMediaUrls?: string[];
}

export interface PrepareAudioResult {
  audioUrl: string;
  mimeType: string;
}

/**
 * Strip markdown so TTS does not read formatting markers aloud.
 */
export function stripMarkdownForSpeech(text: string): string {
  if (!text) return text;

  let clean = text;
  clean = clean.replace(/(\*\*|__|\*|_)(.*?)\1/g, '$2');
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  clean = clean.replace(/^#+\s+/gm, '');
  clean = clean.replace(/^[-*+]\s+/gm, '');
  clean = clean.replace(/```[\s\S]*?```/g, '');
  clean = clean.replace(/`([^`]+)`/g, '$1');
  clean = clean.replace(/~~(.*?)~~/g, '$1');

  return clean.trim();
}

async function synthesizeReplyAudio(text: string): Promise<{ buffer: Buffer; ext: string; mimeType: string }> {
  try {
    const buffer = await synthesizeWithGemini(text, 'Puck', 'wav', 'gemini-3.1-flash-tts-preview');
    return { buffer, ext: 'wav', mimeType: 'audio/wav' };
  } catch (geminiError) {
    console.warn('[long-reply-audio] Gemini TTS failed, falling back to Vercel tts-1.', geminiError);
    const buffer = await synthesizeWithVercel(text, 'alloy', 'mp3', 'tts-1');
    return { buffer, ext: 'mp3', mimeType: 'audio/mpeg' };
  }
}

/**
 * Convert a long reply to audio when the channel supports it.
 * Returns a public audio URL, or null to keep sending text.
 */
export async function tryPrepareLongReplyAudio({
  siteId,
  channel,
  text,
  existingMediaUrls,
}: PrepareAudioParams): Promise<PrepareAudioResult | null> {
  if (!AUDIO_REPLY_CHANNELS.includes(channel)) {
    return null;
  }

  const cleanText = stripMarkdownForSpeech(text);
  if (cleanText.length < LONG_REPLY_AUDIO_THRESHOLD) {
    return null;
  }

  if (existingMediaUrls && existingMediaUrls.length > 0) {
    return null;
  }

  if (cleanText.length > TTS_MAX_CHARS) {
    console.warn(`[long-reply-audio] Text too long for TTS (${cleanText.length} > ${TTS_MAX_CHARS}). Falling back to text.`);
    return null;
  }

  try {
    const estimatedMinutes = cleanText.length / 1000;
    const requiredCredits = Math.max(0.01, estimatedMinutes * CreditService.PRICING.AUDIO_GENERATION_MINUTE);
    const hasCredits = await CreditService.validateCredits(siteId, requiredCredits);

    if (!hasCredits) {
      console.warn('[long-reply-audio] Insufficient credits for TTS. Falling back to text.');
      return null;
    }

    await CreditService.deductCredits(
      siteId,
      requiredCredits,
      'audio_generation',
      'Audio generation for long reply',
      { text_length: cleanText.length, channel }
    );

    console.log(`[long-reply-audio] Synthesizing audio for ${channel} reply (${cleanText.length} chars)`);
    const { buffer, ext, mimeType } = await synthesizeReplyAudio(cleanText);

    const fileName = `reply_audio_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
    const filePath = `${siteId}/${fileName}`;

    const { error: uploadError } = await supabaseAdmin.storage.from('assets').upload(filePath, buffer, {
      contentType: mimeType,
    });

    if (uploadError) {
      throw new Error(`Failed to upload generated audio: ${uploadError.message}`);
    }

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from('assets').getPublicUrl(filePath);

    return {
      audioUrl: publicUrl,
      mimeType,
    };
  } catch (error) {
    console.error('[long-reply-audio] Failed to prepare audio, falling back to text. Error:', error);
    return null;
  }
}
