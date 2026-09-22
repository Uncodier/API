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
  const { data: urlData } = supabaseAdmin.storage
    .from('generative_images')
    .getPublicUrl(path);

  try {
    const response = await fetch(urlData.publicUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as {
        statusCode?: string | number;
        code?: string;
        error?: string;
        message?: string;
      } | null;
      const missing = response.status === 404
        || String(payload?.statusCode) === '404'
        || payload?.code === 'NoSuchKey'
        || payload?.error === 'not_found';
      if (missing) {
        return null;
      }

      throw new Error(
        `Storage returned ${response.status}: ${payload?.message || response.statusText}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: response.headers.get('content-type') || 'image/jpeg',
    };
  } catch (error) {
    throw new Error(
      `Image cache lookup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
