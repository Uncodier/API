import { NextRequest, NextResponse } from 'next/server';
import { ImageGenerationService, ImageGenerationParams } from '@/lib/services/image/ImageGenerationService';

// Valid providers
const VALID_PROVIDERS = ['azure', 'gemini', 'vercel'] as const;
type Provider = typeof VALID_PROVIDERS[number];

// Valid sizes
const VALID_SIZES = ['256x256', '512x512', '1024x1024'] as const;
type Size = typeof VALID_SIZES[number];

// Valid quality options
const VALID_QUALITIES = ['standard', 'hd'] as const;
type Quality = typeof VALID_QUALITIES[number];

// Function to validate UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Endpoint to generate images using AI
 * 
 * @param request Request with image generation parameters
 * @returns Response with generated images and metadata
 * 
 * Parameters:
 * - prompt: (Required) Text description of the image to generate
 * - site_id: (Required) UUID of the site for storage and tracking
 * - provider: (Optional) AI provider to use: 'azure', 'gemini', 'vercel' (default: 'gemini')
 * - size: (Optional) Image size: '256x256', '512x512', '1024x1024' (default: '1024x1024')
 * - n: (Optional) Number of images to generate (default: 1)
 * - quality: (Optional) Image quality: 'standard', 'hd' (default: 'standard')
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Extract parameters
    const { 
      prompt,
      site_id,
      provider = 'gemini',
      size = '1024x1024',
      n = 1,
      quality = 'standard',
      reference_images
    } = body;
    
    console.log(`[GENERATE_IMAGE] 🎨 Starting image generation`);
    console.log(`[GENERATE_IMAGE] 📝 Prompt: ${prompt?.substring(0, 100)}...`);
    console.log(`[GENERATE_IMAGE] 🏢 Site ID: ${site_id}`);
    console.log(`[GENERATE_IMAGE] 🤖 Provider: ${provider}`);
    
    // Validate required parameters
    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'prompt is required and must be a string' 
          } 
        },
        { status: 400 }
      );
    }

    if (!site_id || typeof site_id !== 'string') {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'site_id is required and must be a string' 
          } 
        },
        { status: 400 }
      );
    }

    // Validate site_id format
    if (!isValidUUID(site_id)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'site_id must be a valid UUID' 
          } 
        },
        { status: 400 }
      );
    }

    // Validate provider
    if (provider && !VALID_PROVIDERS.includes(provider as Provider)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: `provider must be one of: ${VALID_PROVIDERS.join(', ')}` 
          } 
        },
        { status: 400 }
      );
    }

    // Validate size
    if (size && !VALID_SIZES.includes(size as Size)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: `size must be one of: ${VALID_SIZES.join(', ')}` 
          } 
        },
        { status: 400 }
      );
    }

    // Validate n (number of images)
    if (n && (typeof n !== 'number' || n < 1 || n > 4)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: 'n must be a number between 1 and 4' 
          } 
        },
        { status: 400 }
      );
    }

    // Validate quality
    if (quality && !VALID_QUALITIES.includes(quality as Quality)) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            code: 'INVALID_REQUEST', 
            message: `quality must be one of: ${VALID_QUALITIES.join(', ')}` 
          } 
        },
        { status: 400 }
      );
    }

    // Validate reference_images if provided
    if (reference_images !== undefined) {
      if (!Array.isArray(reference_images)) {
        return NextResponse.json(
          { 
            success: false, 
            error: { 
              code: 'INVALID_REQUEST', 
              message: 'reference_images must be an array of URLs' 
            } 
          },
          { status: 400 }
        );
      }
      
      // Validate each URL
      const urlRegex = /^https?:\/\/.+/i;
      for (const url of reference_images) {
        if (typeof url !== 'string' || !urlRegex.test(url)) {
          return NextResponse.json(
            { 
              success: false, 
              error: { 
                code: 'INVALID_REQUEST', 
                message: 'All reference_images must be valid HTTP/HTTPS URLs' 
              } 
            },
            { status: 400 }
          );
        }
      }
    }

    console.log(`[GENERATE_IMAGE] ✅ Validation passed, calling ImageGenerationService`);

    // Generate image using the service
    const result = await ImageGenerationService.generateImage({
      prompt,
      site_id,
      provider: provider as Provider,
      size: size as Size,
      n,
      quality: quality as Quality,
      reference_images
    });

    if (result.success) {
      console.log(`[GENERATE_IMAGE] ✅ Image generation successful`);
      console.log(`[GENERATE_IMAGE] 🖼️ Generated ${result.images.length} image(s)`);
      console.log(`[GENERATE_IMAGE] 🤖 Provider used: ${result.provider}`);
      
      if (result.fallbackFrom) {
        console.log(`[GENERATE_IMAGE] 🔄 Fallback from: ${result.fallbackFrom}`);
      }
    } else {
      console.error(`[GENERATE_IMAGE] ❌ Image generation failed: ${result.error}`);
    }

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
    
  } catch (error: any) {
    console.error('[GENERATE_IMAGE] ❌ Error processing image generation:', error);
    return NextResponse.json(
      { 
        success: false,
        error: { 
          code: 'INTERNAL_ERROR', 
          message: 'An error occurred while processing the image generation request' 
        },
        details: error.message
      },
      { status: 500 }
    );
  }
}

/**
 * GET endpoint for API documentation
 */
export async function GET() {
  return NextResponse.json({
    message: "AI Image Generation Tool API",
    description: "Generate images using AI with automatic provider fallback",
    usage: "Send a POST request with the required parameters",
    endpoint: "/api/agents/tools/generateImage",
    methods: ["POST", "GET"],
    required_fields: [
      "prompt",
      "site_id"
    ],
    optional_fields: [
      "provider",
      "size", 
      "n",
      "quality",
      "reference_images"
    ],
    valid_providers: VALID_PROVIDERS,
    valid_sizes: VALID_SIZES,
    valid_qualities: VALID_QUALITIES,
    default_values: {
      provider: "gemini",
      size: "1024x1024",
      n: 1,
      quality: "standard"
    },
    fallback_behavior: "Automatic fallback through providers: gemini -> azure -> vercel",
    response_format: {
      success: "boolean",
      provider: "string - provider that successfully generated the image",
      images: "array of objects with url and optional b64_json",
      fallbackFrom: "string - original provider if fallback occurred",
      error: "string - error message if generation failed",
      metadata: "object with size, n, quality, generated_at"
    },
    examples: {
      basic: {
        prompt: "A beautiful sunset over mountains",
        site_id: "123e4567-e89b-12d3-a456-426614174000"
      },
      advanced: {
        prompt: "A modern office building with glass windows",
        site_id: "123e4567-e89b-12d3-a456-426614174000",
        provider: "azure",
        size: "512x512",
        n: 2,
        quality: "hd"
      },
      with_references: {
        prompt: "A futuristic cityscape inspired by the reference images",
        site_id: "123e4567-e89b-12d3-a456-426614174000",
        provider: "gemini",
        reference_images: [
          "https://example.com/reference1.jpg",
          "https://example.com/reference2.png"
        ]
      }
    }
  });
}
