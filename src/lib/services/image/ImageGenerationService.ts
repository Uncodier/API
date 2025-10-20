/**
 * Image Generation Service
 * Wraps the /ai/image API with fallback logic and error handling
 */

export interface ImageGenerationParams {
  prompt: string;
  site_id: string;
  provider?: 'azure' | 'gemini' | 'vercel';
  size?: '256x256' | '512x512' | '1024x1024';
  n?: number;
  quality?: 'standard' | 'hd' | number;
  ratio?: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3';
  reference_images?: string[];
}

export interface ImageGenerationResult {
  success: boolean;
  provider: string;
  images: Array<{
    url: string;
    b64_json?: string | null;
  }>;
  fallbackFrom?: string;
  error?: string;
  metadata?: {
    size: string;
    n: number;
    quality?: string;
    generated_at: string;
  };
}

export class ImageGenerationService {
  private static readonly FALLBACK_PROVIDERS: Array<'gemini'> = ['gemini'];
  
  /**
   * Generate image with automatic fallback logic
   */
  static async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    const {
      prompt,
      site_id,
      provider = 'gemini', // Default to gemini as specified
      size = '1024x1024',
      n = 1,
      quality = 'standard',
      ratio,
      reference_images
    } = params;


    // Try the requested provider first
    const providersToTry = [provider, ...this.FALLBACK_PROVIDERS.filter(p => p !== provider)];
    
    let lastError: Error | null = null;
    
    for (const currentProvider of providersToTry) {
      try {
        const result = await this.callImageAPI({
          prompt,
          site_id,
          provider: currentProvider,
          size,
          n,
          quality: typeof quality === 'number' ? quality.toString() : quality,
          ratio,
          reference_images
        });

        if (result.success) {
          return {
            ...result,
            fallbackFrom: currentProvider !== provider ? provider : undefined
          };
        }
      } catch (error: any) {
        lastError = error;
        continue;
      }
    }

    // All providers failed
    return {
      success: false,
      provider: 'none',
      images: [],
      error: `All image generation providers failed. Last error: ${lastError?.message || 'Unknown error'}`,
      metadata: {
        size,
        n,
        quality: typeof quality === 'number' ? quality.toString() : quality,
        generated_at: new Date().toISOString()
      }
    };
  }

  /**
   * Call the /ai/image API endpoint
   */
  private static async callImageAPI(params: {
    prompt: string;
    site_id: string;
    provider: 'azure' | 'gemini' | 'vercel';
    size: string;
    n: number;
    quality?: string;
    ratio?: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3';
    reference_images?: string[];
  }): Promise<ImageGenerationResult> {
    const apiUrl = `${process.env.NEXT_PUBLIC_API_SERVER_URL || 'http://localhost:3000'}/api/ai/image`;
    
    const requestBody = {
      prompt: params.prompt,
      site_id: params.site_id,
      provider: params.provider,
      size: params.size,
      n: params.n,
      ...(params.quality && { quality: params.quality }),
      ...(params.ratio && { ratio: params.ratio }),
      ...(params.reference_images && { reference_images: params.reference_images })
    };


    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.SERVICE_API_KEY || '',
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`API request failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error);
    }

    return {
      success: true,
      provider: data.provider,
      images: data.images || [],
      fallbackFrom: data.fallbackFrom,
      metadata: {
        size: params.size,
        n: params.n,
        quality: params.quality,
        generated_at: new Date().toISOString()
      }
    };
  }
}
