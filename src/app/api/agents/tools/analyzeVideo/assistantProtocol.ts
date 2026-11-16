import { zodToJsonSchema } from 'zod-to-json-schema';
import { videoAnalysisSchema, VideoAnalysisError } from '@/lib/services/video-analysis/contract';
import { analyzeVideo } from '@/lib/services/video-analysis/analyze-video';

/** Tenant and instance identity are captured by the authorized host, never the model. */
export function analyzeVideoTool(siteId: string, instanceId: string) {
  return {
    name: 'analyze_video',
    description: 'Understand a video using sampled frames and optional speech transcription. Select independent source intervals for frames and audio (seconds), frame count (1-24) and max resolution (64-1920px; aspect ratio preserved). Defaults: 8 frames at up to 768x768, first 600 seconds, no transcription. For transcription only disable frames and enable transcription. First get a general description, then zoom in by calling again with previous_description and a narrower interval, more frames/higher resolution, or crop {x,y,width,height} normalized to the full source image (0-1). Cropping requires previous_description. Every call performs new paid work. Direct HTTPS media file URLs only, on server-approved hosts; not YouTube page URLs. No native video input is sent to the model. Returns description, transcript and source sampling metadata, not raw frames. Do not retry provider/billing uncertainty automatically.',
    parameters: zodToJsonSchema(videoAnalysisSchema, { $refStrategy: 'none' }),
    execute: async (args: unknown) => {
      try {
        // The shared router adds this metadata to every schema. It is not a media parameter.
        const input = args && typeof args === 'object' && !Array.isArray(args)
          ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'thought_process')) : args;
        return await analyzeVideo(input, { siteId, instanceId });
      }
      catch (error) {
        if (error instanceof VideoAnalysisError) return { success: false, code: error.code, error: error.message };
        return { success: false, code: 'VIDEO_ANALYSIS_FAILED',
          error: 'Video analysis failed. Provider or billing outcome may be uncertain; do not automatically retry paid work.' };
      }
    },
  };
}