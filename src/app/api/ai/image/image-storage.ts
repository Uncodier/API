import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertSafeRemoteUrl } from '@/lib/security/safe-remote-url';
import { readResponseWithLimit } from '@/lib/security/limited-response';

export function getImageEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) console.warn(`[Image API] Missing environment variable ${name}`);
  return value;
}

export async function remoteImageAsBase64(
  url: string,
): Promise<{ data: string; mimeType: string } | null> {
  try {
    const safeUrl = await assertSafeRemoteUrl(url);
    const headers: Record<string, string> = {};
    if (safeUrl.hostname === 'api.twilio.com') {
      const accountSid =
        process.env.GEAR_TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
      const authToken =
        process.env.GEAR_TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN;
      if (accountSid && authToken) {
        headers.Authorization = `Basic ${Buffer.from(
          `${accountSid}:${authToken}`,
        ).toString('base64')}`;
      }
    }

    const response = await fetch(safeUrl, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const buffer = await readResponseWithLimit(response, 15 * 1024 * 1024);
    return {
      data: buffer.toString('base64'),
      mimeType: response.headers.get('content-type') || 'image/png',
    };
  } catch (error) {
    console.warn(
      '[Image API] Unable to load reference image:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function uploadGeneratedImage(input: {
  base64Data: string;
  mimeType: string;
  siteId: string;
}): Promise<{ path: string; url: string; size: number; mimeType: string }> {
  const buffer = Buffer.from(input.base64Data, 'base64');
  const extension = input.mimeType.includes('jpeg')
    || input.mimeType.includes('jpg')
    ? 'jpg'
    : input.mimeType.includes('gif')
      ? 'gif'
      : 'png';
  const path = `${input.siteId}/${Date.now()}_${crypto.randomUUID()}.${extension}`;
  const { data, error } = await supabaseAdmin.storage
    .from('generative_images')
    .upload(path, buffer, {
      contentType: input.mimeType,
      upsert: false,
    });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const publicUrl = supabaseAdmin.storage
    .from('generative_images')
    .getPublicUrl(path)
    .data?.publicUrl;
  let url = publicUrl || '';
  if (!url) {
    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from('generative_images')
      .createSignedUrl(path, 7 * 24 * 60 * 60);
    if (signedError || !signed?.signedUrl) {
      throw new Error(`Unable to create image URL: ${signedError?.message}`);
    }
    url = signed.signedUrl;
  }
  return {
    path: data.path,
    url,
    size: buffer.length,
    mimeType: input.mimeType,
  };
}

export async function saveGeneratedImageRecord(input: {
  siteId: string;
  path: string;
  url: string;
  size: number;
  mimeType: string;
  provider: string;
  prompt: string;
  model?: string;
  instanceId?: string;
}): Promise<void> {
  if (input.siteId === '00000000-0000-0000-0000-000000000000') return;

  const { data: ownership } = await supabaseAdmin
    .from('site_ownership')
    .select('user_id')
    .eq('site_id', input.siteId)
    .maybeSingle();
  const insertData: Record<string, unknown> = {
    site_id: input.siteId,
    name: `${input.provider}_image_${Date.now()}.${input.mimeType.split('/')[1] || 'png'}`,
    file_path: input.url,
    file_type: input.mimeType,
    file_size: input.size,
    metadata: {
      provider: input.provider,
      prompt: input.prompt,
      generated_at: new Date().toISOString(),
      model: input.model || 'unknown',
      storage_path: input.path,
      bucket: 'generative_images',
    },
    is_public: true,
  };
  if (ownership?.user_id) insertData.user_id = ownership.user_id;
  if (input.instanceId) insertData.instance_id = input.instanceId;

  const { error } = await supabaseAdmin.from('assets').insert(insertData);
  if (error) {
    console.warn('[Image API] Unable to save asset record:', error.message);
  }
}

export async function persistGeneratedImage(input: {
  base64Data: string;
  mimeType: string;
  siteId: string;
  provider: string;
  prompt: string;
  model?: string;
  instanceId?: string;
}): Promise<{ url: string; b64_json: null }> {
  const uploaded = await uploadGeneratedImage(input);
  await saveGeneratedImageRecord({
    ...uploaded,
    siteId: input.siteId,
    provider: input.provider,
    prompt: input.prompt,
    model: input.model,
    instanceId: input.instanceId,
  });
  return { url: uploaded.url, b64_json: null };
}
