export type VideoProvider = 'openrouter';
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
  first_frame_url?: string;
  last_frame_url?: string;
  quality?: VideoQuality;
  model?: string;
  resolution?: string;
  job_id?: string;
}

export interface VideoGenerationResult {
  provider: VideoProvider;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  job_id?: string;
  error?: string;
  videos: Array<{ url: string; mimeType: string }>;
  metadata: {
    model: string;
    generation_id?: string;
    cost?: number;
    duration_seconds?: number;
    aspect_ratio?: VideoAspectRatio;
    quality?: VideoQuality;
    resolution?: string;
    generated_at: string;
  };
}
