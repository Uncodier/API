export type ImageProvider = 'azure';
export type ImageQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'standard' | 'hd';
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
  model?: string;
  size?: string;
  n?: number;
  quality?: ImageQuality;
  ratio?: ImageRatio;
  aspect_ratio?: ImageRatio;
  reference_images?: string[];
}

export interface ImageGenerationResult {
  provider: ImageProvider;
  images: Array<{ url: string; b64_json: null }>;
  fallbackFrom?: ImageProvider;
  metadata?: { model: string; generation_id?: string; cost?: number };
}

export interface GenerateImageOptions {
  prompt: string;
  siteId: string;
  instanceId?: string;
  size?: string;
  count: number;
  quality?: ImageQuality;
  model?: string;
  ratio?: ImageRatio;
  referenceImages?: string[];
}
