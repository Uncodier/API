import { getImageEnv, persistGeneratedImage, remoteImageAsBase64 } from './image-storage';
import type {
  GenerateImageOptions,
  ImageGenerationResult,
} from './image-types';

function gatewaySize(options: GenerateImageOptions): string {
  if (options.ratio === '16:9') return '1792x1024';
  if (options.ratio === '9:16') return '1024x1792';
  return options.size || '1024x1024';
}

export async function generateWithVercelGateway(
  options: GenerateImageOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = getImageEnv('VERCEL_AI_GATEWAY_OPENAI');
  const apiKey = getImageEnv('VERCEL_AI_GATEWAY_API_KEY');
  if (!baseUrl || !apiKey) {
    throw new Error('Vercel AI Gateway is not configured');
  }

  const response = await fetch(
    `${baseUrl.replace(/\/$/, '')}/v1/images/generations`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: options.prompt,
        size: gatewaySize(options),
        n: options.count,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(
      `Vercel Gateway image generation failed: ${response.status} ${details}`,
    );
  }

  const payload = await response.json() as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  const images: ImageGenerationResult['images'] = [];
  for (const item of payload.data || []) {
    let image: { data: string; mimeType: string } | null = null;
    if (item.b64_json) {
      image = { data: item.b64_json, mimeType: 'image/png' };
    } else if (item.url) {
      image = await remoteImageAsBase64(item.url);
    }
    if (!image) continue;
    images.push(await persistGeneratedImage({
      base64Data: image.data,
      mimeType: image.mimeType,
      siteId: options.siteId,
      provider: 'vercel',
      prompt: options.prompt,
      model: 'gpt-image-1',
      instanceId: options.instanceId,
    }));
  }
  if (images.length === 0) {
    throw new Error('Vercel Gateway returned no usable images');
  }
  return { provider: 'vercel', images };
}
