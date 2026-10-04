/**
 * Assistant Protocol Wrapper for Generate Video Tool
 * Formats the tool for OpenAI/assistant compatibility
 */

import { VideoGenerationService, VideoGenerationParams } from '@/lib/services/video/VideoGenerationService';
import { createInstanceLogCore } from '@/lib/tools/instance-log-core';
import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';

export interface GenerateVideoToolParams {
  prompt: string;
  provider?: 'openrouter';
  duration_seconds?: number;
  duration?: number;
  aspect_ratio?: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3';
  reference_images?: string[];
  first_frame_url?: string;
  last_frame_url?: string;
  quality?: 'preview' | 'standard' | 'pro';
  model?: string;
  job_id?: string;
  resolution?: string;
}

/**
 * Creates a generateVideo tool for OpenAI/assistant compatibility
 * @param site_id - The site ID to use for video generation
 * @param instance_id - Optional instance ID to link generated videos to the instance
 * @returns Tool definition compatible with OpenAI function calling
 */
export function generateVideoTool(site_id: string, instance_id?: string) {
  return {
    name: 'generate_video',
    description: 'Submit or poll asynchronous OpenRouter video generation. Requires an explicitly configured video model. Return pending job_id to poll; never claim completion while pending. Videos are automatically saved to storage and can be used in conversations or content.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed text description of the video to generate. Be specific about style, colors, composition, movement, and any important details.'
        },
        provider: {
          type: 'string',
          enum: ['openrouter'],
          description: 'OpenRouter is the only supported provider; no direct provider fallback.'
        },
        duration_seconds: {
          type: 'number',
          minimum: 1,
          maximum: 60,
          description: 'Desired duration of the video in seconds. Must be supported by the selected model; defaults to 4 seconds. No OpenRouter duration coercion.'
        },
        duration: {
          type: 'number',
          minimum: 1,
          maximum: 60,
          description: 'Desired duration of the video in seconds.'
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
          description: 'Aspect ratio of the generated video. Must be supported by the selected model; defaults to 16:9.'
        },
        reference_images: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Array of image URLs (up to 3) to use as reference/context for generation. IMPORTANT: If there are Image URLs for reference provided in the context, you MUST include them here as strings.'
        },
        first_frame_url: {
          type: 'string',
          description: 'Authoritative first frame URL for image-to-video generation. UI node bindings may force this value.'
        },
        last_frame_url: {
          type: 'string',
          description: 'Last frame URL, only when the selected model advertises last_frame support.'
        },
        quality: {
          type: 'string',
          enum: ['preview', 'standard', 'pro'],
          description: 'Deprecated and rejected. Omit quality and use resolution instead.'
        },
        job_id: { type: 'string', description: 'Previously returned local job UUID. Polls it without creating or billing another generation.' },
        resolution: { type: 'string', description: 'Model-supported resolution, e.g. 720p or 1080p.' },
        model: {
          type: 'string',
          description: 'OpenRouter model override; OPENROUTER_VIDEO_MODEL must be configured. No implicit Sora Pro substitution.'
        }
      },
      required: ['prompt']
    },
    execute: async (args: GenerateVideoToolParams) => {
      if (args.provider !== undefined && args.provider !== 'openrouter') throw new Error('Unsupported video provider');
      try {
        console.log(`[GenerateVideoTool] 🎬 Executing video generation`);
        // Authorization and billing belong exclusively to the local media API.

        console.log(`[GenerateVideoTool] 🏢 Site ID: ${site_id}`);

        // Validate required parameters
        if (!args.prompt || typeof args.prompt !== 'string') {
          return {
            success: false,
            error: 'prompt is required and must be a string',
            provider: 'none',
            videos: []
          };
        }

        // Prepare parameters for the service; never switch provider accounts on failure
        const actualDuration = args.duration !== undefined ? args.duration : args.duration_seconds;
        const serviceParams: VideoGenerationParams = {
          prompt: args.prompt,
          site_id: site_id,
          instance_id: instance_id,
          provider: args.provider ?? 'openrouter',
          duration_seconds: actualDuration,
          aspect_ratio: args.aspect_ratio,
          reference_images: args.reference_images,
          first_frame_url: args.first_frame_url,
          last_frame_url: args.last_frame_url,
          quality: args.quality,
          job_id: args.job_id,
          resolution: args.resolution,
          model: args.model
        };
        

        // Call the video generation service
        const result = await VideoGenerationService.generateVideo(serviceParams);

        if (result.job_id && (result.status !== 'completed' || !result.success)) {
          return { ...result, message: result.error || 'Video is not ready. Retain job_id and poll this same job after 30 seconds; do not submit again.' };
        }
        if (result.success) {
          console.log(`[GenerateVideoTool] ✅ Video generation successful`);
          console.log(`[GenerateVideoTool] 🎥 Generated ${result.videos.length} video(s)`);
          console.log(`[GenerateVideoTool] 🤖 Provider used: ${result.provider}`);
          
          if (result.fallbackFrom) {
            console.log(`[GenerateVideoTool] 🔄 Fallback from: ${result.fallbackFrom}`);
          }

          // Format response for the assistant
          // CRITICAL: Do not return any base64 data to prevent OpenAI executor errors
          const videoUrls = result.videos.map(video => video.url);
          
          if (instance_id) {
            try {
              // Extract a reasonable filename from the URL or fallback
              for (const video of result.videos) {
                const urlParts = video.url.split('/');
                const fileName = urlParts[urlParts.length - 1] || `generated_video_${Date.now()}.mp4`;
                
                const { supabaseAdmin } = await import('@/lib/database/supabase-client');
                await supabaseAdmin.from('instance_assets').insert({
                  instance_id: instance_id,
                  asset_url: video.url,
                  asset_type: 'video',
                  name: fileName,
                  source: 'generated'
                });
              }

              await createInstanceLogCore({
                site_id,
                instance_id,
                log_type: 'agent_action',
                level: 'info',
                message: `Video generated successfully: ${videoUrls.join(', ')}`,
                details: {
                  provider: result.provider,
                  videos: result.videos,
                  prompt: args.prompt,
                  type: 'media_delivery',
                  media_type: 'video'
                }
              });
            } catch (e) {
              console.error('[GenerateVideoTool] Failed to log media delivery:', e);
            }
          }

          return {
            success: true,
            provider: result.provider,
            videos: result.videos.map(video => ({ url: video.url, mimeType: video.mimeType })),
            fallbackFrom: result.fallbackFrom,
            status: result.status,
            job_id: result.job_id,
            metadata: result.metadata,
            message: `Successfully generated ${result.videos.length} video(s) using ${result.provider}${result.fallbackFrom ? ` (fallback from ${result.fallbackFrom})` : ''}. Videos are saved and ready to use. URLs: ${videoUrls.join(', ')}`
          };
        } else {
          console.error(`[GenerateVideoTool] ❌ Video generation failed: ${result.error}`);
          
          // CRITICAL: For failed tool executions, we need to throw an error
          // This ensures the calling code treats it as an error, not as successful output
          throw new Error(`Video generation failed: ${result.error}. No alternate provider was called.`);
        }

      } catch (error: any) {
        console.error(`[GenerateVideoTool] ❌ Unexpected error:`, error);
        
        // CRITICAL: Re-throw the error to ensure it's treated as a tool execution failure
        // This ensures the calling code puts it in the error field, not the output field
        throw error;
      }
    }
  };
}

/**
 * Helper function to create the tool with a specific site_id
 * This is useful for robot integrations where site_id is known
 */
export function createGenerateVideoTool(site_id: string) {
  if (!site_id || typeof site_id !== 'string') {
    throw new Error('site_id is required and must be a string');
  }
  
  return generateVideoTool(site_id);
}

/**
 * Creates a generateVideo tool for Scrapybara SDK compatibility
 * Uses tool() helper from scrapybara/tools with Zod schemas
 * @param instance - The Scrapybara UbuntuInstance
 * @param site_id - The site ID to use for video generation
 * @returns Tool definition compatible with Scrapybara SDK
 */
export function generateVideoToolScrapybara(instance: UbuntuInstance, site_id: string) {
  return tool({
    name: 'generate_video',
    description: 'Submit or poll asynchronous OpenRouter video generation. Requires an explicitly configured video model. Return pending job_id to poll; never claim completion while pending. Videos are automatically saved to storage and can be used in conversations or content.',
    parameters: z.object({
      prompt: z.string().describe('Detailed text description of the video to generate. Be specific about style, colors, composition, movement, and any important details.'),
      provider: z.enum(['openrouter']).optional().describe('OpenRouter is the only supported provider; no direct provider fallback.'),
      duration_seconds: z.number().min(1).max(60).optional().describe('Desired duration of the video in seconds. Must be supported by the selected model; defaults to 4 seconds. No OpenRouter duration coercion.'),
      duration: z.number().min(1).max(60).optional().describe('Desired duration of the video in seconds.'),
      aspect_ratio: z.enum(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']).optional().describe('Aspect ratio of the generated video. Must be supported by the selected model; defaults to 16:9.'),
      reference_images: z.array(z.string()).optional().describe('Array of image URLs (up to 3) to use as reference/context for generation. IMPORTANT: If there are Image URLs for reference provided in the context, you MUST include them here as strings.'),
      first_frame_url: z.string().optional().describe('Authoritative first frame URL for image-to-video generation.'),
      last_frame_url: z.string().optional().describe('Last frame URL, only when the selected model advertises last_frame support.'),
      quality: z.enum(['preview', 'standard', 'pro']).optional().describe('Deprecated and rejected. Omit quality and use resolution instead.'),
      job_id: z.string().uuid().optional(),
      resolution: z.string().optional(),
      model: z.string().optional().describe('OpenRouter model override; OPENROUTER_VIDEO_MODEL must be configured. No implicit Sora Pro substitution.')
    }),
    execute: async (args) => {
      if (args.provider !== undefined && args.provider !== 'openrouter') throw new Error('Unsupported video provider');
      try {
        console.log(`[GenerateVideoTool-Scrapybara] 🎬 Executing video generation`);
        // Authorization and billing belong exclusively to the local media API.

        console.log(`[GenerateVideoTool-Scrapybara] 🏢 Site ID: ${site_id}`);

        // Validate required parameters
        if (!args.prompt || typeof args.prompt !== 'string') {
          return {
            success: false,
            error: 'prompt is required and must be a string',
            provider: 'none',
            videos: []
          };
        }

        // Prepare parameters for the service; never switch provider accounts on failure
        const actualDuration = args.duration !== undefined ? args.duration : args.duration_seconds;
        const serviceParams: VideoGenerationParams = {
          prompt: args.prompt,
          site_id: site_id,
          provider: args.provider ?? 'openrouter',
          duration_seconds: actualDuration,
          aspect_ratio: args.aspect_ratio,
          reference_images: args.reference_images,
          first_frame_url: args.first_frame_url,
          last_frame_url: args.last_frame_url,
          quality: args.quality,
          job_id: args.job_id,
          resolution: args.resolution,
          model: args.model
        };

        // Call the video generation service
        const result = await VideoGenerationService.generateVideo(serviceParams);

        if (result.job_id && (result.status !== 'completed' || !result.success)) {
          return { ...result, message: result.error || 'Video is not ready. Retain job_id and poll this same job after 30 seconds; do not submit again.' };
        }
        if (result.success) {
          console.log(`[GenerateVideoTool-Scrapybara] ✅ Video generation successful`);
          console.log(`[GenerateVideoTool-Scrapybara] 🎥 Generated ${result.videos.length} video(s)`);
          console.log(`[GenerateVideoTool-Scrapybara] 🤖 Provider used: ${result.provider}`);
          
          if (result.fallbackFrom) {
            console.log(`[GenerateVideoTool-Scrapybara] 🔄 Fallback from: ${result.fallbackFrom}`);
          }

          // Format response for the assistant
          const videoUrls = result.videos.map(video => video.url);
          
          return {
            success: true,
            provider: result.provider,
            videos: result.videos.map(video => ({ url: video.url, mimeType: video.mimeType })),
            fallbackFrom: result.fallbackFrom,
            status: result.status,
            job_id: result.job_id,
            metadata: result.metadata,
            message: `Successfully generated ${result.videos.length} video(s) using ${result.provider}${result.fallbackFrom ? ` (fallback from ${result.fallbackFrom})` : ''}. Videos are saved and ready to use. URLs: ${videoUrls.join(', ')}`
          };
        } else {
          console.error(`[GenerateVideoTool-Scrapybara] ❌ Video generation failed: ${result.error}`);
          throw new Error(`Video generation failed: ${result.error}. No alternate provider was called.`);
        }

      } catch (error: any) {
        console.error(`[GenerateVideoTool-Scrapybara] ❌ Unexpected error:`, error);
        throw error;
      }
    }
  });
}














