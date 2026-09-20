export type ImageProvider = 'azure' | 'gemini' | 'vercel';
export type ImageRatio =
  | '1:1'
  | '4:3'
  | '3:4'
  | '16:9'
  | '9:16'
  | '3:2'
  | '2:3';

export interface ImageRequestBody {
  prompt: string;
  site_id: string;
  instance_id?: string;
  provider?: ImageProvider;
  size?: '256x256' | '512x512' | '1024x1024';
  n?: number;
  quality?: 'standard' | 'hd' | number;
  ratio?: ImageRatio;
  aspect_ratio?: ImageRatio;
  reference_images?: string[];
}

export interface ImageGenerationResult {
  provider: ImageProvider;
  images: Array<{ url: string; b64_json: null }>;
  fallbackFrom?: ImageProvider;
}

export interface GenerateImageOptions {
  prompt: string;
  siteId: string;
  instanceId?: string;
  size?: string;
  count: number;
  quality?: 'standard' | 'hd' | number;
  ratio?: ImageRatio;
  referenceImages?: string[];
}
