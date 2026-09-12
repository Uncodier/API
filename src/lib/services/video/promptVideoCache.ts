import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Generate a deterministic hash for a prompt and duration
 */
export function getVideoPromptHash(prompt: string, duration: number, ratio: string): string {
  const normalizedPrompt = prompt.trim().toLowerCase();
  const data = `${normalizedPrompt}|${duration}s|${ratio}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Download a video from the prompt cache
 */
export async function downloadVideoFromCache(hash: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const path = `prompt_cache/${hash}`;
  const { data, error } = await supabaseAdmin.storage.from('generative_videos').download(path);
  
  if (error || !data) {
    return null;
  }
  
  const arrayBuffer = await data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = data.type || 'video/mp4';
  
  return { buffer, mimeType };
}

/**
 * Upload a video to the prompt cache
 */
export async function uploadVideoToCache(hash: string, buffer: Buffer, mimeType: string): Promise<{ path: string; url: string }> {
  const path = `prompt_cache/${hash}`;
  
  const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
    .from('generative_videos')
    .upload(path, buffer, {
      contentType: mimeType,
      upsert: true,
    });
    
  if (uploadError) {
    throw new Error(`Cache upload failed: ${uploadError.message}`);
  }
  
  const { data: urlData } = supabaseAdmin.storage.from('generative_videos').getPublicUrl(path);
  return { path, url: urlData.publicUrl };
}