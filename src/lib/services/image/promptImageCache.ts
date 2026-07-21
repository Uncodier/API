import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Generate a deterministic hash for a prompt and dimensions
 */
export function getPromptHash(prompt: string, width: number, height: number): string {
  const normalizedPrompt = prompt.trim().toLowerCase();
  const data = `${normalizedPrompt}|${width}x${height}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Download an image from the prompt cache
 */
export async function downloadFromCache(hash: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const path = `prompt_cache/${hash}`;
  const { data, error } = await supabaseAdmin.storage.from('generative_images').download(path);
  
  if (error || !data) {
    return null;
  }
  
  const arrayBuffer = await data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = data.type || 'image/jpeg';
  
  return { buffer, mimeType };
}

/**
 * Upload an image to the prompt cache
 */
export async function uploadToCache(hash: string, buffer: Buffer, mimeType: string): Promise<{ path: string; url: string }> {
  const path = `prompt_cache/${hash}`;
  
  const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
    .from('generative_images')
    .upload(path, buffer, {
      contentType: mimeType,
      upsert: true,
    });
    
  if (uploadError) {
    throw new Error(`Cache upload failed: ${uploadError.message}`);
  }
  
  const { data: urlData } = supabaseAdmin.storage.from('generative_images').getPublicUrl(path);
  return { path, url: urlData.publicUrl };
}
