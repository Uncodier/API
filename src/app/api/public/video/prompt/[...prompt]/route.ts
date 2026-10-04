import { NextRequest, NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { generatePromptVideoWorkflow, GeneratePromptVideoInput } from '../workflow';
import { getVideoPromptHash, downloadVideoFromCache } from '@/lib/services/video/promptVideoCache';
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
    const prefix = '/api/public/video/prompt/';
    
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
    if (searchParams.has('provider') && searchParams.get('provider') !== 'openrouter') {
      return jsonError('Unsupported video provider', 400);
    }
    let durationSeconds = Number(searchParams.get('duration') || '4');
    const expectedSiteId = searchParams.get('site_id');
    const ratioParam = searchParams.get('ratio') || '16:9';

    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
      return jsonError('duration must be an integer between 1 and 60', 400);
    }

    let ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' = '16:9';
    if (['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'].includes(ratioParam)) {
      ratio = ratioParam as typeof ratio;
    }

    if (!hasAuthenticatedPrincipal(request)) {
      return jsonError('Authentication is required to access generated videos', 401);
    }

    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');
    const originOrReferer = origin || referer;

    const siteId = expectedSiteId
      || (originOrReferer
        ? await resolveSiteFromRequirementUrl(originOrReferer)
        : null);

    if (!siteId) {
      return jsonError('A site_id is required for video generation', 400);
    }
    if (!await canAccessSite(request, siteId)) {
      return jsonError('Site access denied', 403);
    }

    const hash = getVideoPromptHash(
      `v3:openrouter:${process.env.OPENROUTER_VIDEO_MODEL || 'unconfigured'}:${siteId}:${promptStr}`,
      durationSeconds,
      ratio,
    );
    const cached = await downloadVideoFromCache(hash);
    if (cached) {
      return new NextResponse(cached.buffer as unknown as BodyInit, {
        headers: {
          'Content-Type': cached.mimeType,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const lockKey = `lock:public-video:${hash}`;
    const lock = await acquireLock(lockKey, 900);
    if (lock.state === 'contended') {
      return jsonError('Video generation is already in progress', 409);
    }
    if (lock.state !== 'acquired') {
      return jsonError('Video generation admission is unavailable', 503);
    }
    try {
      const rechecked = await downloadVideoFromCache(hash);
      if (rechecked) {
        return new NextResponse(rechecked.buffer as unknown as BodyInit, {
          headers: {
            'Content-Type': rechecked.mimeType,
            'Cache-Control': 'private, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      const workflowInput: GeneratePromptVideoInput = {
        prompt: promptStr,
        siteId,
        durationSeconds,
        ratio,
        hash,
      };
      const run = await start(generatePromptVideoWorkflow, [workflowInput]);
      try {
        const outcome = await run.returnValue;
        if (outcome.status !== 'completed') {
          return NextResponse.json(outcome, {
            status: outcome.status === 'failed' ? 502 : 202,
            headers: { ...NO_STORE_HEADERS, 'Retry-After': '30' },
          });
        }
      } catch (workflowError: any) {
        return jsonError(
          'Video generation failed',
          502,
          'Retry the existing job status; do not resubmit an uncertain generation'
        );
      }

      const finalCached = await downloadVideoFromCache(hash);
      if (finalCached) {
        return new NextResponse(finalCached.buffer as unknown as BodyInit, {
          headers: {
            'Content-Type': finalCached.mimeType,
            'Cache-Control': 'private, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      return jsonError('Video generation completed but video was not found in cache', 502);
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  } catch (error: any) {
    return jsonError('Internal server error', 500);
  }
}