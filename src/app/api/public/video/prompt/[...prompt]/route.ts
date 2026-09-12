import { NextRequest, NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { generatePromptVideoWorkflow, GeneratePromptVideoInput } from '../workflow';
import { getVideoPromptHash, downloadVideoFromCache } from '@/lib/services/video/promptVideoCache';
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

    const searchParams = request.nextUrl.searchParams;
    let durationSeconds = parseInt(searchParams.get('duration') || '5', 10);
    const expectedSiteId = searchParams.get('site_id');
    const ratioParam = searchParams.get('ratio') || '16:9';

    if (isNaN(durationSeconds) || durationSeconds <= 0) durationSeconds = 5;

    let ratio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' = '16:9';
    if (['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'].includes(ratioParam)) {
      ratio = ratioParam as typeof ratio;
    }

    const hash = getVideoPromptHash(promptStr, durationSeconds, ratio);

    // 1. Cache hit → return video bytes
    const cached = await downloadVideoFromCache(hash);
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

    // 3. Start workflow and wait for the generated video
    const workflowInput: GeneratePromptVideoInput = {
      prompt: promptStr,
      siteId,
      durationSeconds,
      ratio,
      hash,
    };

    const runId = `video-prompt-${hash}`;
    const run = await start(generatePromptVideoWorkflow, [workflowInput]);

    try {
      await run.returnValue;
    } catch (workflowError: any) {
      console.error('[PublicPromptVideo] Workflow failed:', workflowError);
      return jsonError(
        'Video generation failed',
        502,
        workflowError?.message || String(workflowError)
      );
    }

    // 4. Return cached video after successful generation
    const finalCached = await downloadVideoFromCache(hash);
    if (finalCached) {
      return new NextResponse(finalCached.buffer as unknown as BodyInit, {
        headers: {
          'Content-Type': finalCached.mimeType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return jsonError('Video generation completed but video was not found in cache', 502);
  } catch (error: any) {
    console.error('[PublicPromptVideo] Unhandled error:', error);
    return jsonError('Internal server error', 500, error?.message || String(error));
  }
}