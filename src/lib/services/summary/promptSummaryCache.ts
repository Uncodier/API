import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Generate a deterministic hash for a text prompt
 */
export function getPromptHash(prompt: string): string {
  const normalizedPrompt = prompt.trim().toLowerCase();
  const data = `summary|${normalizedPrompt}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Download a summary from the prompt cache
 */
export async function downloadFromCache(hash: string): Promise<string | null> {
  const path = `prompt_summary_cache/${hash}.json`;
  const { data, error } = await supabaseAdmin.storage.from('generative_images').download(path);
  
  if (error || !data) {
    return null;
  }
  
  const text = await data.text();
  try {
    const json = JSON.parse(text);
    return json.summary || null;
  } catch (e) {
    return null;
  }
}

/**
 * Upload a summary to the prompt cache
 */
export async function uploadToCache(hash: string, summary: string): Promise<{ path: string; url: string }> {
  const path = `prompt_summary_cache/${hash}.json`;
  const buffer = Buffer.from(JSON.stringify({ summary }));
  
  const { error: uploadError } = await supabaseAdmin.storage
    .from('generative_images')
    .upload(path, buffer, {
      contentType: 'application/json',
      upsert: true,
    });
    
  if (uploadError) {
    throw new Error(`Cache upload failed: ${uploadError.message}`);
  }
  
  const { data: urlData } = supabaseAdmin.storage.from('generative_images').getPublicUrl(path);
  return { path, url: urlData.publicUrl };
}
