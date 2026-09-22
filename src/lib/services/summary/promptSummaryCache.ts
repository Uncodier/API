import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  deleteRedisKeys,
  readRedisJson,
  writeRedisJson,
} from '@/lib/services/redis-json-cache';

function valueKey(hash: string): string {
  return `cache:prompt-summary:${hash}`;
}

function missKey(hash: string): string {
  return `cache:prompt-summary-miss:${hash}`;
}

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
  const cached = await readRedisJson<{ summary: string }>(valueKey(hash));
  if (cached?.summary) return cached.summary;
  if (await readRedisJson<boolean>(missKey(hash))) return null;

  const path = `prompt_summary_cache/${hash}.json`;
  const { data, error } = await supabaseAdmin.storage.from('generative_images').download(path);
  
  if (error) {
    const storageError = error as { statusCode?: string | number; message?: string };
    if (
      String(storageError.statusCode) === '404'
      || /not found|does not exist/i.test(storageError.message || '')
    ) {
      await writeRedisJson(missKey(hash), true, 15);
      return null;
    }
    throw new Error(`Summary cache lookup failed: ${error.message}`);
  }
  if (!data) {
    return null;
  }
  
  const text = await data.text();
  try {
    const json = JSON.parse(text);
    const summary = json.summary || null;
    if (summary) {
      await writeRedisJson(valueKey(hash), { summary }, 24 * 60 * 60);
    }
    return summary;
  } catch {
    throw new Error('Summary cache entry is invalid');
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
  await deleteRedisKeys(missKey(hash));
  await writeRedisJson(valueKey(hash), { summary }, 24 * 60 * 60);
  
  const { data: urlData } = supabaseAdmin.storage.from('generative_images').getPublicUrl(path);
  return { path, url: urlData.publicUrl };
}
