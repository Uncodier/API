import { NextRequest, NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { generatePromptImageWorkflow, GeneratePromptImageInput } from '../../../image/prompt/workflow';
import { getPromptHash, downloadFromCache } from '@/lib/services/image/promptImageCache';
import { resolveSiteFromRequirementUrl } from '@/lib/services/image/resolveSiteFromRequirementUrl';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function jsonError(error: string, status: number, details?: string) {
  return NextResponse.json(
    details ? { error, details } : { error },
    { status, headers: NO_STORE_HEADERS }
  );
}

function safeDecode(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    try {
      // Replace % not followed by 2 hex digits with %25
      return decodeURIComponent(str.replace(/%(?![0-9a-fA-F]{2})/g, '%25'));
    } catch {
      return str;
    }
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ prompt: string[] }> }
) {
  try {
    let rawPrompt = '';
    const prefix = '/api/public/icon/prompt/';
    
    if (request.nextUrl.pathname.startsWith(prefix)) {
      rawPrompt = request.nextUrl.pathname.slice(prefix.length);
    } else {
      try {
        const params = await context.params;
        const promptParts = params.prompt || [];
        rawPrompt = promptParts.join('/');
      } catch (e) {
        // Ignore params decoding errors, fallback is empty string which will return 400
      }
    }

    const promptStr = safeDecode(rawPrompt);

    if (!promptStr || promptStr.trim() === '') {
      return jsonError('Prompt is required', 400);
    }

    const searchParams = request.nextUrl.searchParams;
    let width = parseInt(searchParams.get('width') || '256', 10);
    let height = parseInt(searchParams.get('height') || '256', 10);
    const expectedSiteId = searchParams.get('site_id');
    const bg = searchParams.get('bg') || 'transparent or solid white';

    if (isNaN(width) || width <= 0) width = 256;
    if (isNaN(height) || height <= 0) height = 256;

    const maxDim = Math.max(width, height);
    const sizeMap: '256x256' | '512x512' | '1024x1024' =
      maxDim <= 256 ? '256x256' : maxDim <= 512 ? '512x512' : '1024x1024';

    let ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' | undefined = undefined;
    ratio = '1:1'; // icons are typically square

    // Modify the prompt for icon generation
    const iconPrompt = `A high quality minimalist vector app icon of ${promptStr}, clean lines, flat design, isolated on a ${bg} background, no text.`;
    const hash = getPromptHash(iconPrompt, width, height);

    // 1. Cache hit → return image bytes
    const cached = await downloadFromCache(hash);
    if (cached) {
      return new NextResponse(cached.buffer as unknown as BodyInit, {
        headers: {
          'Content-Type': cached.mimeType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // 2. Cache miss → validate client via requirement URL
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');
    const originOrReferer = origin || referer;

    if (!originOrReferer) {
      return jsonError('Missing Origin or Referer to resolve requirement', 403);
    }

    let isOfficialApp = false;
    try {
      const hn = !originOrReferer.startsWith('http') 
        ? new URL(`https://${originOrReferer}`).hostname 
        : new URL(originOrReferer).hostname;
        
      if (
        hn === 'app.makinari.com' ||
        hn === 'www.makinari.com' ||
        hn === 'makinari.com' ||
        hn === 'localhost' ||
        hn === '127.0.0.1'
      ) {
        isOfficialApp = true;
      }
    } catch(e) {}

    let siteId: string | null = null;
    if (isOfficialApp) {
      siteId = '00000000-0000-0000-0000-000000000000'; // System site ID for official app
      if (expectedSiteId) {
        siteId = expectedSiteId; // Allow official app to specify any site_id
      }
    } else {
      siteId = await resolveSiteFromRequirementUrl(originOrReferer, expectedSiteId);
      
      // If expectedSiteId was provided but resolving failed, it means validation failed
      if (expectedSiteId && !siteId) {
        return NextResponse.json(
          { error: `URL does not belong to the requested site_id: ${expectedSiteId}` },
          { status: 403, headers: NO_STORE_HEADERS }
        );
      }
    }

    if (!siteId) {
      return jsonError('Domain not authorized for prompt generation', 403);
    }

    // 3. Start workflow and wait for the generated image
    const workflowInput: GeneratePromptImageInput = {
      prompt: iconPrompt,
      siteId,
      size: sizeMap,
      ratio,
      hash,
    };

    const runId = `img-prompt-${hash}`;
    const run = await start(generatePromptImageWorkflow, [workflowInput]);

    try {
      await run.returnValue;
    } catch (workflowError: any) {
      console.error('[PublicPromptImage] Workflow failed:', workflowError);
      return jsonError(
        'Image generation failed',
        502,
        workflowError?.message || String(workflowError)
      );
    }

    // 4. Return cached image after successful generation
    const finalCached = await downloadFromCache(hash);
    if (finalCached) {
      return new NextResponse(finalCached.buffer as unknown as BodyInit, {
        headers: {
          'Content-Type': finalCached.mimeType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return jsonError('Image generation completed but image was not found in cache', 502);
  } catch (error: any) {
    console.error('[PublicPromptImage] Unhandled error:', error);
    return jsonError('Internal server error', 500, error?.message || String(error));
  }
}
