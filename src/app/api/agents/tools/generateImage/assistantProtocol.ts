/**
 * Assistant Protocol Wrapper for Generate Image Tool
 * Formats the tool for OpenAI/assistant compatibility
 */

import { ImageGenerationService, ImageGenerationParams } from '@/lib/services/image/ImageGenerationService';
import { tool } from 'scrapybara/tools';
import { z } from 'zod';
import type { UbuntuInstance } from 'scrapybara';

export interface GenerateImageToolParams {
  prompt: string;
  provider?: 'azure' | 'gemini' | 'vercel';
  size?: '256x256' | '512x512' | '1024x1024';
  n?: number;
  quality?: 'standard' | 'hd';
  ratio?: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3';
  reference_images?: string[];
}

/**
 * Creates a generateImage tool for OpenAI/assistant compatibility
 * @param site_id - The site ID to use for image generation
 * @returns Tool definition compatible with OpenAI function calling
 */
export function generateImageTool(site_id: string) {
  return {
    name: 'generate_image',
    description: 'Generate images using AI with automatic provider fallback. Supports multiple AI providers (Gemini, Azure, Vercel) with automatic fallback if one fails. Images are automatically saved to storage and can be used in conversations or content.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed text description of the image to generate. Be specific about style, colors, composition, and any important details.'
        },
        provider: {
          type: 'string',
          enum: ['gemini'],
          description: 'AI provider to use for generation. Only Gemini is currently supported.'
        },
        size: {
          type: 'string',
          enum: ['256x256', '512x512', '1024x1024'],
          description: 'Size of the generated image. Defaults to 1024x1024 for best quality.'
        },
        n: {
          type: 'number',
          minimum: 1,
          maximum: 4,
          description: 'Number of images to generate. Defaults to 1.'
        },
        quality: {
          type: 'string',
          enum: ['standard', 'hd'],
          description: 'Quality of the generated image. HD quality is higher resolution but may take longer. Defaults to standard.'
        },
        ratio: {
          type: 'string',
          enum: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
          description: 'Aspect ratio of the generated image. Defaults to 1:1 (square).'
        },
        reference_images: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Array of image URLs to use as reference/context for generation. Images will be converted to base64 and sent as context to the AI model.'
        }
      },
      required: ['prompt']
    },
    execute: async (args: GenerateImageToolParams) => {
      try {
        console.log(`[GenerateImageTool] 🎨 Executing image generation`);
        console.log(`[GenerateImageTool] 📝 Prompt: ${args.prompt.substring(0, 100)}...`);
        console.log(`[GenerateImageTool] 🏢 Site ID: ${site_id}`);
        console.log(`[GenerateImageTool] 🤖 Provider: gemini (only supported provider)`);

        // Validate required parameters
        if (!args.prompt || typeof args.prompt !== 'string') {
          return {
            success: false,
            error: 'prompt is required and must be a string',
            provider: 'none',
            images: []
          };
        }

        // Prepare parameters for the service - only Gemini supported
        const serviceParams: ImageGenerationParams = {
          prompt: args.prompt,
          site_id: site_id,
          provider: 'gemini', // Force Gemini only
          size: args.size,
          n: args.n,
          quality: args.quality,
          ratio: args.ratio,
          reference_images: args.reference_images
        };
        

        // Call the image generation service
        const result = await ImageGenerationService.generateImage(serviceParams);

        if (result.success) {
          console.log(`[GenerateImageTool] ✅ Image generation successful`);
          console.log(`[GenerateImageTool] 🖼️ Generated ${result.images.length} image(s)`);
          console.log(`[GenerateImageTool] 🤖 Provider used: ${result.provider}`);
          
          if (result.fallbackFrom) {
            console.log(`[GenerateImageTool] 🔄 Fallback from: ${result.fallbackFrom}`);
          }

          // Format response for the assistant
          // CRITICAL: Do not return any base64 data to prevent OpenAI executor errors
          const imageUrls = result.images.map(img => img.url);
          
          return {
            success: true,
            provider: result.provider,
            images: imageUrls.map(url => ({ url })),
            fallbackFrom: result.fallbackFrom,
            metadata: result.metadata,
            message: `Successfully generated ${result.images.length} image(s) using ${result.provider}${result.fallbackFrom ? ` (fallback from ${result.fallbackFrom})` : ''}. Images are saved and ready to use. URLs: ${imageUrls.join(', ')}`
          };
        } else {
          console.error(`[GenerateImageTool] ❌ Image generation failed: ${result.error}`);
          
          // CRITICAL: For failed tool executions, we need to throw an error
          // This ensures the calling code treats it as an error, not as successful output
          throw new Error(`Image generation failed: ${result.error}. All providers (gemini, azure, vercel) were unable to generate the image.`);
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
    description: 'Generate images using AI with automatic provider fallback. Supports multiple AI providers (Gemini, Azure, Vercel) with automatic fallback if one fails. Images are automatically saved to storage and can be used in conversations or content.',
    parameters: z.object({
      prompt: z.string().describe('Detailed text description of the image to generate. Be specific about style, colors, composition, and any important details.'),
      provider: z.enum(['gemini']).optional().describe('AI provider to use for generation. Only Gemini is currently supported.'),
      size: z.enum(['256x256', '512x512', '1024x1024']).optional().describe('Size of the generated image. Defaults to 1024x1024 for best quality.'),
      n: z.number().min(1).max(4).optional().describe('Number of images to generate. Defaults to 1.'),
      quality: z.enum(['standard', 'hd']).optional().describe('Quality of the generated image. HD quality is higher resolution but may take longer. Defaults to standard.'),
      ratio: z.enum(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']).optional().describe('Aspect ratio of the generated image. Defaults to 1:1 (square).'),
      reference_images: z.array(z.string()).optional().describe('Array of image URLs to use as reference/context for generation. Images will be converted to base64 and sent as context to the AI model.')
    }),
    execute: async (args) => {
      try {
        console.log(`[GenerateImageTool-Scrapybara] 🎨 Executing image generation`);
        console.log(`[GenerateImageTool-Scrapybara] 📝 Prompt: ${args.prompt.substring(0, 100)}...`);
        console.log(`[GenerateImageTool-Scrapybara] 🏢 Site ID: ${site_id}`);
        console.log(`[GenerateImageTool-Scrapybara] 🤖 Provider: gemini (only supported provider)`);

        // Validate required parameters
        if (!args.prompt || typeof args.prompt !== 'string') {
          return {
            success: false,
            error: 'prompt is required and must be a string',
            provider: 'none',
            images: []
          };
        }

        // Prepare parameters for the service - only Gemini supported
        const serviceParams: ImageGenerationParams = {
          prompt: args.prompt,
          site_id: site_id,
          provider: 'gemini', // Force Gemini only
          size: args.size,
          n: args.n,
          quality: args.quality,
          ratio: args.ratio,
          reference_images: args.reference_images
        };

        // Call the image generation service
        const result = await ImageGenerationService.generateImage(serviceParams);

        if (result.success) {
          console.log(`[GenerateImageTool-Scrapybara] ✅ Image generation successful`);
          console.log(`[GenerateImageTool-Scrapybara] 🖼️ Generated ${result.images.length} image(s)`);
          console.log(`[GenerateImageTool-Scrapybara] 🤖 Provider used: ${result.provider}`);
          
          if (result.fallbackFrom) {
            console.log(`[GenerateImageTool-Scrapybara] 🔄 Fallback from: ${result.fallbackFrom}`);
          }

          // Format response for the assistant
          const imageUrls = result.images.map(img => img.url);
          
          return {
            success: true,
            provider: result.provider,
            images: imageUrls.map(url => ({ url })),
            fallbackFrom: result.fallbackFrom,
            metadata: result.metadata,
            message: `Successfully generated ${result.images.length} image(s) using ${result.provider}${result.fallbackFrom ? ` (fallback from ${result.fallbackFrom})` : ''}. Images are saved and ready to use. URLs: ${imageUrls.join(', ')}`
          };
        } else {
          console.error(`[GenerateImageTool-Scrapybara] ❌ Image generation failed: ${result.error}`);
          throw new Error(`Image generation failed: ${result.error}. All providers (gemini, azure, vercel) were unable to generate the image.`);
        }

      } catch (error: any) {
        console.error(`[GenerateImageTool-Scrapybara] ❌ Unexpected error:`, error);
        throw error;
      }
    }
  });
}
