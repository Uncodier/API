import { NextRequest, NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { generatePromptImageWorkflow, GeneratePromptImageInput } from '../workflow';
import { getPromptHash, downloadFromCache } from '@/lib/services/image/promptImageCache';
import { resolveSiteFromRequirementUrl } from '@/lib/services/image/resolveSiteFromRequirementUrl';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

function jsonError(error: string, status: number, details?: string) {
  return NextResponse.json(
    details ? { error, details } : { error },
    { status, headers: NO_STORE_HEADERS }
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ prompt: string[] }> }
) {
  try {
    const params = await context.params;
    const promptParts = params.prompt || [];
    const promptStr = decodeURIComponent(promptParts.join('/'));

    if (!promptStr || promptStr.trim() === '') {
      return jsonError('Prompt is required', 400);
    }

    const searchParams = request.nextUrl.searchParams;
    let width = parseInt(searchParams.get('width') || '1024', 10);
    let height = parseInt(searchParams.get('height') || '1024', 10);

    if (isNaN(width) || width <= 0) width = 1024;
    if (isNaN(height) || height <= 0) height = 1024;

    const maxDim = Math.max(width, height);
    const sizeMap: '256x256' | '512x512' | '1024x1024' =
      maxDim <= 256 ? '256x256' : maxDim <= 512 ? '512x512' : '1024x1024';

    let ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' | undefined = undefined;
    const ar = width / height;
    if (ar > 1.7) ratio = '16:9';
    else if (ar > 1.4) ratio = '3:2';
    else if (ar > 1.2) ratio = '4:3';
    else if (ar < 0.6) ratio = '9:16';
    else if (ar < 0.7) ratio = '2:3';
    else if (ar < 0.85) ratio = '3:4';
    else ratio = '1:1';

    const hash = getPromptHash(promptStr, width, height);

    // 1. Cache hit → return image bytes
    const cached = await downloadFromCache(hash);
    if (cached) {
      return new NextResponse(cached.buffer, {
        headers: {
          'Content-Type': cached.mimeType,
          'Cache-Control': 'public, max-age=31536000, immutable',
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

    const siteId = await resolveSiteFromRequirementUrl(originOrReferer);
    if (!siteId) {
      return jsonError('Domain not authorized for prompt generation', 403);
    }

    // 3. Start workflow and wait for the generated image
    const workflowInput: GeneratePromptImageInput = {
      prompt: promptStr,
      siteId,
      size: sizeMap,
      ratio,
      hash,
    };

    const runId = `img-prompt-${hash}`;
    const run = await start(generatePromptImageWorkflow, [workflowInput], { workflowId: runId });

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
      return new NextResponse(finalCached.buffer, {
        headers: {
          'Content-Type': finalCached.mimeType,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    return jsonError('Image generation completed but image was not found in cache', 502);
  } catch (error: any) {
    console.error('[PublicPromptImage] Unhandled error:', error);
    return jsonError('Internal server error', 500, error?.message || String(error));
  }
}
