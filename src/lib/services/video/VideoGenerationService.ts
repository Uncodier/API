/**
 * Video Generation Service
 * Wraps the /ai/video API with fallback logic and error handling
 */

export type AspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3';
export type VideoQuality = 'preview' | 'standard' | 'pro';

export interface VideoGenerationParams {
  prompt: string;
  site_id: string;
  instance_id?: string;
  provider?: 'gemini';
  duration_seconds?: number;
  aspect_ratio?: AspectRatio;
  reference_images?: string[];
  quality?: VideoQuality;
  model?: string;
}

export interface VideoGenerationResult {
  success: boolean;
  provider: string;
  videos: Array<{
    url: string;
    mimeType: string;
  }>;
  fallbackFrom?: string;
  error?: string;
  metadata?: {
    model: string;
    duration_seconds?: number;
    aspect_ratio?: AspectRatio;
    quality?: VideoQuality;
    resolution?: '720p' | '1080p';
    generated_at: string;
  };
}

export class VideoGenerationService {
  private static readonly FALLBACK_PROVIDERS: Array<'gemini'> = ['gemini'];
  
  /**
   * Generate video with automatic fallback logic
   */
  static async generateVideo(params: VideoGenerationParams): Promise<VideoGenerationResult> {
    const {
      prompt,
      site_id,
      instance_id,
      provider = 'gemini', // Default to gemini as specified
      duration_seconds,
      aspect_ratio,
      reference_images,
      quality,
      model
    } = params;

    // Try the requested provider first
    const providersToTry = [provider, ...this.FALLBACK_PROVIDERS.filter(p => p !== provider)];
    
    let lastError: Error | null = null;
    
    for (const currentProvider of providersToTry) {
      try {
        const result = await this.callVideoAPI({
          prompt,
          site_id,
          instance_id,
          provider: currentProvider,
          duration_seconds,
          aspect_ratio,
          reference_images,
          quality,
          model
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
      videos: [],
      error: `All video generation providers failed. Last error: ${lastError?.message || 'Unknown error'}`,
      metadata: {
        model: model || 'veo-3.1-generate-preview',
        duration_seconds,
        aspect_ratio,
        quality,
        generated_at: new Date().toISOString()
      }
    };
  }

  /**
   * Call the /ai/video API endpoint
   */
  private static async callVideoAPI(params: {
    prompt: string;
    site_id: string;
    instance_id?: string;
    provider: 'gemini';
    duration_seconds?: number;
    aspect_ratio?: AspectRatio;
    reference_images?: string[];
    quality?: VideoQuality;
    model?: string;
  }): Promise<VideoGenerationResult> {
    const apiUrl = `${process.env.NEXT_PUBLIC_API_SERVER_URL || 'http://localhost:3000'}/api/ai/video`;
    
    console.log(`[VideoGenService] 🌐 Calling: ${apiUrl}`);
    console.log(`[VideoGenService] 🔑 API Key: ${process.env.SERVICE_API_KEY ? 'SET' : 'NOT_SET'}`);
    console.log(`[VideoGenService] 🤖 Provider: ${params.provider}`);
    
    const requestBody = {
      prompt: params.prompt,
      site_id: params.site_id,
      ...(params.instance_id && { instance_id: params.instance_id }),
      provider: params.provider,
      ...(params.duration_seconds !== undefined && { duration_seconds: params.duration_seconds }),
      ...(params.aspect_ratio && { aspect_ratio: params.aspect_ratio }),
      ...(params.reference_images && { reference_images: params.reference_images }),
      ...(params.quality && { quality: params.quality }),
      ...(params.model && { model: params.model })
    };

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.SERVICE_API_KEY || '',
        },
        body: JSON.stringify(requestBody)
      });

      console.log(`[VideoGenService] ✅ Fetch completed - Status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.error(`[VideoGenService] ❌ Response not OK: ${errorText.substring(0, 200)}`);
        throw new Error(`API request failed: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error);
      }

      return {
        success: true,
        provider: data.provider,
        videos: data.videos || [],
        fallbackFrom: data.fallbackFrom,
        metadata: {
          model: data.metadata?.model || params.model || 'veo-3.1-generate-preview',
          duration_seconds: data.metadata?.duration_seconds ?? params.duration_seconds,
          aspect_ratio: data.metadata?.aspect_ratio || params.aspect_ratio,
          quality: data.metadata?.quality || params.quality,
          resolution: data.metadata?.resolution,
          generated_at: data.metadata?.generated_at || new Date().toISOString()
        }
      };
    } catch (error: any) {
      console.error(`[VideoGenService] ❌ Fetch error:`, {
        name: error.name,
        message: error.message,
        code: error.code,
        cause: error.cause
      });
      throw error;
    }
  }
}












