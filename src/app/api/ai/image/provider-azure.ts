import { getImageEnv, persistGeneratedImage, remoteImageAsBase64 } from './image-storage';
import type {
  GenerateImageOptions,
  ImageGenerationResult,
  ImageRatio,
} from './image-types';

function azureSize(size: string | undefined, ratio: ImageRatio | undefined): string {
  if (!ratio) return size || '1024x1024';
  if (ratio === '16:9') return '1792x1024';
  if (ratio === '9:16') return '1024x1792';
  return '1024x1024';
}

export async function generateWithAzure(
  options: GenerateImageOptions,
): Promise<ImageGenerationResult> {
  const endpoint = getImageEnv('MICROSOFT_AZURE_OPENAI_ENDPOINT');
  const apiKey = getImageEnv('MICROSOFT_AZURE_OPENAI_API_KEY');
  const deployment =
    getImageEnv('MICROSOFT_AZURE_OPENAI_IMAGES_DEPLOYMENT') || 'dall-e-3';
  const apiVersion =
    getImageEnv('MICROSOFT_AZURE_OPENAI_API_VERSION') || '2024-08-01-preview';
  if (!endpoint || !apiKey) {
    throw new Error('Azure OpenAI image generation is not configured');
  }

  const response = await fetch(
    `${endpoint.replace(/\/$/, '')}/openai/images/generations?api-version=${encodeURIComponent(apiVersion)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        model: deployment,
        prompt: options.prompt,
        size: azureSize(options.size, options.ratio),
        n: options.count,
        quality: options.quality,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Azure image generation failed: ${response.status} ${details}`);
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
      provider: 'azure',
      prompt: options.prompt,
      model: deployment,
      instanceId: options.instanceId,
    }));
  }
  if (images.length === 0) throw new Error('Azure returned no usable images');
  return { provider: 'azure', images };
}
