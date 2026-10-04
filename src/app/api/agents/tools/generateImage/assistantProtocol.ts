/**
 * Assistant Protocol Wrapper for Generate Image Tool
 * Formats the tool for OpenAI/assistant compatibility
 */

import { ImageGenerationService, ImageGenerationParams } from '@/lib/services/image/ImageGenerationService';
import { createInstanceLogCore } from '@/lib/tools/instance-log-core';
import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';
import type { ImageRequestBody } from '@/app/api/ai/image/image-types';

export type GenerateImageToolParams = Omit<ImageRequestBody, 'site_id' | 'instance_id'>;

/**
 * Creates a generateImage tool for OpenAI/assistant compatibility
 * @param site_id - The site ID to use for image generation
 * @param instance_id - Optional instance ID to link generated images to the instance
 * @returns Tool definition compatible with OpenAI function calling
 */
export function generateImageTool(site_id: string, instance_id?: string) {
  return {
    name: 'generate_image',
    description: 'Generate images exclusively via Azure OpenAI using the configured image deployment. Images are automatically saved to storage and can be used in conversations or content.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed text description of the image to generate. Be specific about style, colors, composition, and any important details.'
        },
        provider: {
          type: 'string',
          enum: ['azure'],
          description: 'Azure is the only supported image provider; no provider fallback.'
        },
        model: { type: 'string', description: 'Azure image deployment override; defaults to AZURE_OPENAI_IMAGE_DEPLOYMENT.' },
        size: {
          type: 'string',
          pattern: '^(auto|[1-9][0-9]*x[1-9][0-9]*)$',
          description: 'Image size: auto, 1024x1024, 1536x1024, 1024x1536, or custom WIDTHxHEIGHT supported by the Azure deployment. Defaults to 1024x1024.'
        },
        n: {
          type: 'number',
          minimum: 1,
          maximum: 4,
          description: 'Number of images to generate. Defaults to 1.'
        },
        quality: {
          type: 'string',
          enum: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'standard', 'hd'],
          description: 'Azure image quality hint; supported labels are normalized by the image adapter.'
        },
        ratio: {
          type: 'string',
          enum: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
          description: 'Aspect ratio of the generated image. Defaults to 1:1 (square).'
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
          description: 'Aspect ratio of the generated image. Defaults to 1:1 (square). Use this instead of ratio for consistency.'
        },
        reference_images: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Array of image URLs to use as reference/context for generation with the Azure image deployment.'
        }
      },
      required: ['prompt']
    },
    execute: async (args: GenerateImageToolParams) => {
      if (args.provider !== undefined && args.provider !== 'azure') throw new Error('Unsupported image provider');
      try {
        console.log(`[GenerateImageTool] 🎨 Executing image generation`);
        // Authorization and billing belong exclusively to the local media API.

        console.log(`[GenerateImageTool] 🏢 Site ID: ${site_id}`);

        // Validate required parameters
        if (!args.prompt || typeof args.prompt !== 'string') {
          return {
            success: false,
            error: 'prompt is required and must be a string',
            provider: 'none',
            images: []
          };
        }

        // Prepare parameters for the service; never switch provider accounts on failure
        const serviceParams: ImageGenerationParams = {
          prompt: args.prompt,
          site_id: site_id,
          instance_id: instance_id,
          provider: args.provider ?? 'azure',
          model: args.model,
          size: args.size,
          n: args.n,
          quality: args.quality,
          ratio: args.ratio,
          aspect_ratio: args.aspect_ratio,
          reference_images: args.reference_images
        };
        

        // Call the image generation service
        const result = await ImageGenerationService.generateImage(serviceParams);

        if (result.success) {
          console.log(`[GenerateImageTool] ✅ Image generation successful`);
          console.log(`[GenerateImageTool] 🖼️ Generated ${result.images.length} image(s)`);
          console.log(`[GenerateImageTool] 🤖 Provider used: ${result.provider}`);
          
          // Format response for the assistant
          // CRITICAL: Do not return any base64 data to prevent OpenAI executor errors
          const imageUrls = result.images.map(img => img.url);
          
          if (instance_id) {
            try {
              // Extract a reasonable filename from the URL or fallback
              for (const url of imageUrls) {
                const urlParts = url.split('/');
                const fileName = urlParts[urlParts.length - 1] || `generated_image_${Date.now()}.png`;
                
                const { supabaseAdmin } = await import('@/lib/database/supabase-client');
                await supabaseAdmin.from('instance_assets').insert({
                  instance_id: instance_id,
                  asset_url: url,
                  asset_type: 'image',
                  name: fileName,
                  source: 'generated'
                });
              }

              await createInstanceLogCore({
                site_id,
                instance_id,
                log_type: 'agent_action',
                level: 'info',
                message: `Image generated successfully: ${imageUrls.join(', ')}`,
                details: {
                  provider: result.provider,
                  images: result.images,
                  prompt: args.prompt,
                  type: 'media_delivery',
                  media_type: 'image'
                }
              });
            } catch (e) {
              console.error('[GenerateImageTool] Failed to log media delivery:', e);
            }
          }

          return {
            success: true,
            provider: result.provider,
            images: imageUrls.map(url => ({ url })),
            metadata: result.metadata,
            message: `Successfully generated ${result.images.length} image(s) using ${result.provider}. Images are saved and ready to use. URLs: ${imageUrls.join(', ')}`
          };
        } else {
          console.error(`[GenerateImageTool] ❌ Image generation failed: ${result.error}`);
          
          // CRITICAL: For failed tool executions, we need to throw an error
          // This ensures the calling code treats it as an error, not as successful output
          throw new Error(`Image generation failed: ${result.error}. No alternate provider was called.`);
        }

      } catch (error: any) {
        console.error(`[GenerateImageTool] ❌ Unexpected error:`, error);
        
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
export function createGenerateImageTool(site_id: string) {
  if (!site_id || typeof site_id !== 'string') {
    throw new Error('site_id is required and must be a string');
  }
  
  return generateImageTool(site_id);
}

/**
 * Creates a generateImage tool for Scrapybara SDK compatibility
 * Uses tool() helper from scrapybara/tools with Zod schemas
 * @param instance - The Scrapybara UbuntuInstance
 * @param site_id - The site ID to use for image generation
 * @returns Tool definition compatible with Scrapybara SDK
 */
export function generateImageToolScrapybara(instance: UbuntuInstance, site_id: string) {
  return tool({
    name: 'generate_image',
    description: 'Generate images exclusively via Azure OpenAI using the configured image deployment. Images are automatically saved to storage and can be used in conversations or content.',
    parameters: z.object({
      prompt: z.string().describe('Detailed text description of the image to generate. Be specific about style, colors, composition, and any important details.'),
      provider: z.enum(['azure']).optional().describe('Azure is the only supported image provider; no provider fallback.'),
      model: z.string().optional().describe('Azure image deployment override; defaults to AZURE_OPENAI_IMAGE_DEPLOYMENT.'),
      size: z.string().regex(/^(auto|[1-9][0-9]*x[1-9][0-9]*)$/).optional().describe('Image size: auto, 1024x1024, 1536x1024, 1024x1536, or custom WIDTHxHEIGHT supported by the Azure deployment. Defaults to 1024x1024.'),
      n: z.number().min(1).max(4).optional().describe('Number of images to generate. Defaults to 1.'),
      quality: z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'standard', 'hd']).optional().describe('Azure image quality hint; supported labels are normalized by the image adapter.'),
      ratio: z.enum(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']).optional().describe('Aspect ratio of the generated image. Defaults to 1:1 (square).'),
      aspect_ratio: z.enum(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']).optional().describe('Aspect ratio of the generated image. Defaults to 1:1 (square). Use this instead of ratio for consistency.'),
      reference_images: z.array(z.string()).optional().describe('Array of image URLs to use as reference/context for generation with the Azure image deployment.')
    }),
    execute: async (args) => {
      if (args.provider !== undefined && args.provider !== 'azure') throw new Error('Unsupported image provider');
      try {
        console.log(`[GenerateImageTool-Scrapybara] 🎨 Executing image generation`);
        // Authorization and billing belong exclusively to the local media API.

        console.log(`[GenerateImageTool-Scrapybara] 🏢 Site ID: ${site_id}`);

        // Validate required parameters
        if (!args.prompt || typeof args.prompt !== 'string') {
          return {
            success: false,
            error: 'prompt is required and must be a string',
            provider: 'none',
            images: []
          };
        }

        // Prepare parameters for the service; never switch provider accounts on failure
        const serviceParams: ImageGenerationParams = {
          prompt: args.prompt,
          site_id: site_id,
          provider: args.provider ?? 'azure',
          model: args.model,
          size: args.size,
          n: args.n,
          quality: args.quality,
          ratio: args.ratio,
          aspect_ratio: args.aspect_ratio,
          reference_images: args.reference_images
        };

        // Call the image generation service
        const result = await ImageGenerationService.generateImage(serviceParams);

        if (result.success) {
          console.log(`[GenerateImageTool-Scrapybara] ✅ Image generation successful`);
          console.log(`[GenerateImageTool-Scrapybara] 🖼️ Generated ${result.images.length} image(s)`);
          console.log(`[GenerateImageTool-Scrapybara] 🤖 Provider used: ${result.provider}`);
          
          // Format response for the assistant
          const imageUrls = result.images.map(img => img.url);
          
          return {
            success: true,
            provider: result.provider,
            images: imageUrls.map(url => ({ url })),
            metadata: result.metadata,
            message: `Successfully generated ${result.images.length} image(s) using ${result.provider}. Images are saved and ready to use. URLs: ${imageUrls.join(', ')}`
          };
        } else {
          console.error(`[GenerateImageTool-Scrapybara] ❌ Image generation failed: ${result.error}`);
          throw new Error(`Image generation failed: ${result.error}. No alternate provider was called.`);
        }

      } catch (error: any) {
        console.error(`[GenerateImageTool-Scrapybara] ❌ Unexpected error:`, error);
        throw error;
      }
    }
  });
}
