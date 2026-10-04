import type { ImageRequestBody, ImageProvider } from '@/app/api/ai/image/image-types';

export type ImageGenerationParams = ImageRequestBody;
export interface ImageGenerationResult {
  success: boolean;
  provider: ImageProvider;
  images: Array<{ url: string; b64_json?: string | null }>;
  error?: string;
  metadata?: { model?: string; generation_id?: string; cost?: number; size?: string; n: number; quality?: string; generated_at: string };
}

/** The local API exclusively owns authorization, storage and billing. No retries/fallbacks. */
export class ImageGenerationService {
  static async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    const provider = params.provider ?? 'azure';
    if (provider !== 'azure') return { success: false, provider: 'azure', images: [], error: 'Unsupported image provider' };
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_SERVER_URL || 'http://localhost:3000'}/api/ai/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.SERVICE_API_KEY || '' },
        body: JSON.stringify({ ...params, provider }),
        redirect: 'error',
        signal: AbortSignal.timeout(240_000),
      });
      if (!response.ok) {
        return { success: false, provider, images: [], error: `Image API request failed (${response.status})` };
      }
      const data = await response.json();
      if (data.provider !== provider) {
        return { success: false, provider, images: [], error: 'Image API returned an unsupported provider' };
      }
      if (data.error || !data.images?.length) {
        return { success: false, provider, images: [], error: 'Image API returned no images' };
      }
      return {
        success: true, provider, images: data.images,
        metadata: {
          ...data.metadata, size: params.size, n: data.images.length,
          quality: params.quality?.toString(), generated_at: new Date().toISOString(),
        },
      };
    } catch {
      return { success: false, provider, images: [], error: 'Image API request failed or timed out; generation outcome may be uncertain' };
    }
  }
}