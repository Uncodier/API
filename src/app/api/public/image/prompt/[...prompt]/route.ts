import { NextRequest, NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { generatePromptImageWorkflow, GeneratePromptImageInput } from '../workflow';
import { getPromptHash, downloadFromCache } from '@/lib/services/image/promptImageCache';
import { resolveSiteFromRequirementUrl } from '@/lib/services/image/resolveSiteFromRequirementUrl';
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit';
import { canAccessSite } from '@/lib/security/site-access';
import { acquireLock, releaseLock } from '@/lib/security/upstash-rest';

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
    const prefix = '/api/public/image/prompt/';
    
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
    if (promptStr.length > 2_000) {
      return jsonError('Prompt must be 2000 characters or fewer', 400);
    }

    const searchParams = request.nextUrl.searchParams;
    let width = parseInt(searchParams.get('width') || '1024', 10);
    let height = parseInt(searchParams.get('height') || '1024', 10);
    const expectedSiteId = searchParams.get('site_id');

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

    if (!hasAuthenticatedPrincipal(request)) {
      return jsonError('Authentication is required to access generated images', 401);
    }

    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');
    const originOrReferer = origin || referer;

    const siteId = expectedSiteId
      || (originOrReferer
        ? await resolveSiteFromRequirementUrl(originOrReferer)
        : null);

    if (!siteId) {
      return jsonError('A site_id is required for image generation', 400);
    }
    if (!await canAccessSite(request, siteId)) {
      return jsonError('Site access denied', 403);
    }

    const hash = getPromptHash(`v2:${siteId}:${promptStr}`, width, height);
    const cached = await downloadFromCache(hash);
    if (cached) {
      return new NextResponse(cached.buffer as unknown as BodyInit, {
        headers: {
          'Content-Type': cached.mimeType,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const lockKey = `lock:public-image:${hash}`;
    const lock = await acquireLock(lockKey, 600);
    if (lock.state === 'contended') {
      return jsonError('Image generation is already in progress', 409);
    }
    if (lock.state !== 'acquired') {
      return jsonError('Image generation admission is unavailable', 503);
    }
    try {
      const rechecked = await downloadFromCache(hash);
      if (rechecked) {
        return new NextResponse(rechecked.buffer as unknown as BodyInit, {
          headers: {
            'Content-Type': rechecked.mimeType,
            'Cache-Control': 'private, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      const workflowInput: GeneratePromptImageInput = {
        prompt: promptStr,
        siteId,
        size: sizeMap,
        ratio,
        hash,
      };
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

      const finalCached = await downloadFromCache(hash);
      if (finalCached) {
        return new NextResponse(finalCached.buffer as unknown as BodyInit, {
          headers: {
            'Content-Type': finalCached.mimeType,
            'Cache-Control': 'private, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      return jsonError('Image generation completed but image was not found in cache', 502);
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  } catch (error: any) {
    console.error('[PublicPromptImage] Unhandled error:', error);
    return jsonError('Internal server error', 500, error?.message || String(error));
  }
}
