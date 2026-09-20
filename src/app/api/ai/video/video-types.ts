export type VideoProvider = 'gemini';
export type VideoAspectRatio =
  | '1:1'
  | '4:3'
  | '3:4'
  | '16:9'
  | '9:16'
  | '3:2'
  | '2:3';
export type VideoQuality = 'preview' | 'standard' | 'pro';

export interface VideoRequestBody {
  prompt: string;
  site_id: string;
  instance_id?: string;
  provider?: VideoProvider;
  duration_seconds?: number;
  aspect_ratio?: VideoAspectRatio;
  reference_images?: string[];
  quality?: VideoQuality;
  model?: string;
}

export interface VideoGenerationResult {
  provider: VideoProvider;
  videos: Array<{ url: string; mimeType: string }>;
  metadata: {
    model: string;
    duration_seconds?: number;
    aspect_ratio?: VideoAspectRatio;
    quality?: VideoQuality;
    resolution?: '720p' | '1080p';
    generated_at: string;
  };
}
