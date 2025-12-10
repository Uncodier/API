/**
 * Assistant Protocol Wrapper for Generate Video Tool
 * Formats the tool for OpenAI/assistant compatibility
 */

import { VideoGenerationService, VideoGenerationParams } from '@/lib/services/video/VideoGenerationService';
import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';

export interface GenerateVideoToolParams {
  prompt: string;
  provider?: 'gemini';
  duration_seconds?: number;
  aspect_ratio?: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3';
  reference_images?: string[];
  quality?: 'preview' | 'standard' | 'pro';
  model?: string;
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
    description: 'Generate videos using AI with automatic provider fallback. Supports Gemini Veo 3.1 for video generation. Videos are automatically saved to storage and can be used in conversations or content.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed text description of the video to generate. Be specific about style, colors, composition, movement, and any important details.'
        },
        provider: {
          type: 'string',
          enum: ['gemini'],
          description: 'AI provider to use for generation. Only Gemini is currently supported.'
        },
        duration_seconds: {
          type: 'number',
          minimum: 1,
          maximum: 60,
          description: 'Desired duration of the video in seconds. Will be mapped to valid values (4, 6, or 8 seconds) by the API. Defaults to 8 seconds.'
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
          description: 'Aspect ratio of the generated video. Note: Gemini only supports 16:9 and 9:16, other ratios will be mapped to 16:9. Defaults to 16:9.'
        },
        reference_images: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Array of image URLs (up to 3) to use as reference/context for generation. Images will be converted to base64 and sent as context to the AI model. When using reference images, duration must be 8 seconds.'
        },
        quality: {
          type: 'string',
          enum: ['preview', 'standard', 'pro'],
          description: 'Quality of the generated video. "preview" and "standard" use 720p. "pro" uses 1080p but requires duration=8 and aspect_ratio=16:9. Defaults to standard.'
        },
        model: {
          type: 'string',
          description: 'Override the Gemini model to use (default: veo-3.1-generate-preview).'
        }
      },
      required: ['prompt']
    },
    execute: async (args: GenerateVideoToolParams) => {
      try {
        console.log(`[GenerateVideoTool] 🎬 Executing video generation`);
        console.log(`[GenerateVideoTool] 📝 Prompt: ${args.prompt.substring(0, 100)}...`);
        console.log(`[GenerateVideoTool] 🏢 Site ID: ${site_id}`);
        console.log(`[GenerateVideoTool] 🤖 Provider: gemini (only supported provider)`);

        // Validate required parameters
        if (!args.prompt || typeof args.prompt !== 'string') {
          return {
            success: false,
            error: 'prompt is required and must be a string',
            provider: 'none',
            videos: []
          };
        }

        // Prepare parameters for the service - only Gemini supported
        const serviceParams: VideoGenerationParams = {
          prompt: args.prompt,
          site_id: site_id,
          instance_id: instance_id,
          provider: 'gemini', // Force Gemini only
          duration_seconds: args.duration_seconds,
          aspect_ratio: args.aspect_ratio,
          reference_images: args.reference_images,
          quality: args.quality,
          model: args.model
        };
        

        // Call the video generation service
        const result = await VideoGenerationService.generateVideo(serviceParams);

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
          
          return {
            success: true,
            provider: result.provider,
            videos: result.videos.map(video => ({ url: video.url, mimeType: video.mimeType })),
            fallbackFrom: result.fallbackFrom,
            metadata: result.metadata,
            message: `Successfully generated ${result.videos.length} video(s) using ${result.provider}${result.fallbackFrom ? ` (fallback from ${result.fallbackFrom})` : ''}. Videos are saved and ready to use. URLs: ${videoUrls.join(', ')}`
          };
        } else {
          console.error(`[GenerateVideoTool] ❌ Video generation failed: ${result.error}`);
          
          // CRITICAL: For failed tool executions, we need to throw an error
          // This ensures the calling code treats it as an error, not as successful output
          throw new Error(`Video generation failed: ${result.error}. All providers (gemini) were unable to generate the video.`);
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
    description: 'Generate videos using AI with automatic provider fallback. Supports Gemini Veo 3.1 for video generation. Videos are automatically saved to storage and can be used in conversations or content.',
    parameters: z.object({
      prompt: z.string().describe('Detailed text description of the video to generate. Be specific about style, colors, composition, movement, and any important details.'),
      provider: z.enum(['gemini']).optional().describe('AI provider to use for generation. Only Gemini is currently supported.'),
      duration_seconds: z.number().min(1).max(60).optional().describe('Desired duration of the video in seconds. Will be mapped to valid values (4, 6, or 8 seconds) by the API. Defaults to 8 seconds.'),
      aspect_ratio: z.enum(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']).optional().describe('Aspect ratio of the generated video. Note: Gemini only supports 16:9 and 9:16, other ratios will be mapped to 16:9. Defaults to 16:9.'),
      reference_images: z.array(z.string()).optional().describe('Array of image URLs (up to 3) to use as reference/context for generation. Images will be converted to base64 and sent as context to the AI model. When using reference images, duration must be 8 seconds.'),
      quality: z.enum(['preview', 'standard', 'pro']).optional().describe('Quality of the generated video. "preview" and "standard" use 720p. "pro" uses 1080p but requires duration=8 and aspect_ratio=16:9. Defaults to standard.'),
      model: z.string().optional().describe('Override the Gemini model to use (default: veo-3.1-generate-preview).')
    }),
    execute: async (args) => {
      try {
        console.log(`[GenerateVideoTool-Scrapybara] 🎬 Executing video generation`);
        console.log(`[GenerateVideoTool-Scrapybara] 📝 Prompt: ${args.prompt.substring(0, 100)}...`);
        console.log(`[GenerateVideoTool-Scrapybara] 🏢 Site ID: ${site_id}`);
        console.log(`[GenerateVideoTool-Scrapybara] 🤖 Provider: gemini (only supported provider)`);

        // Validate required parameters
        if (!args.prompt || typeof args.prompt !== 'string') {
          return {
            success: false,
            error: 'prompt is required and must be a string',
            provider: 'none',
            videos: []
          };
        }

        // Prepare parameters for the service - only Gemini supported
        const serviceParams: VideoGenerationParams = {
          prompt: args.prompt,
          site_id: site_id,
          provider: 'gemini', // Force Gemini only
          duration_seconds: args.duration_seconds,
          aspect_ratio: args.aspect_ratio,
          reference_images: args.reference_images,
          quality: args.quality,
          model: args.model
        };

        // Call the video generation service
        const result = await VideoGenerationService.generateVideo(serviceParams);

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
            metadata: result.metadata,
            message: `Successfully generated ${result.videos.length} video(s) using ${result.provider}${result.fallbackFrom ? ` (fallback from ${result.fallbackFrom})` : ''}. Videos are saved and ready to use. URLs: ${videoUrls.join(', ')}`
          };
        } else {
          console.error(`[GenerateVideoTool-Scrapybara] ❌ Video generation failed: ${result.error}`);
          throw new Error(`Video generation failed: ${result.error}. All providers (gemini) were unable to generate the video.`);
        }

      } catch (error: any) {
        console.error(`[GenerateVideoTool-Scrapybara] ❌ Unexpected error:`, error);
        throw error;
      }
    }
  });
}












