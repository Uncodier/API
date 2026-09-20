import { NextRequest, NextResponse } from 'next/server';
import { getPromptHash, downloadFromCache, uploadToCache } from '@/lib/services/summary/promptSummaryCache';
import { resolveSiteFromRequirementUrl } from '@/lib/services/image/resolveSiteFromRequirementUrl';
import { SummaryGenerationService } from '@/lib/services/summary/SummaryGenerationService';
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit';
import { canAccessSite } from '@/lib/security/site-access';
import { acquireLock, releaseLock } from '@/lib/security/upstash-rest';

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

function safeDecode(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    try {
      return decodeURIComponent(str.replace(/%(?![0-9a-fA-F]{2})/g, '%25'));
    } catch {
      return str;
    }
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ prompt: string[] }> }
) {
  try {
    let rawPrompt = '';
    const prefix = '/api/public/summary/prompt/';
    
    if (request.nextUrl.pathname.startsWith(prefix)) {
      rawPrompt = request.nextUrl.pathname.slice(prefix.length);
    } else {
      try {
        const params = await context.params;
        const promptParts = params.prompt || [];
        rawPrompt = promptParts.join('/');
      } catch (e) {
        // Ignore params decoding errors
      }
    }

    const promptStr = safeDecode(rawPrompt);

    if (!promptStr || promptStr.trim() === '') {
      return jsonError('Prompt is required', 400);
    }
    if (promptStr.length > 2_000) {
      return jsonError('Prompt must be 2000 characters or fewer', 400);
    }

    const expectedSiteId = request.nextUrl.searchParams.get('site_id');

    if (!hasAuthenticatedPrincipal(request)) {
      return jsonError('Authentication is required to access generated summaries', 401);
    }

    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');
    const originOrReferer = origin || referer;

    const siteId = expectedSiteId
      || (originOrReferer
        ? await resolveSiteFromRequirementUrl(originOrReferer)
        : null);

    if (!siteId) {
      return jsonError('A site_id is required for summary generation', 400);
    }
    if (!await canAccessSite(request, siteId)) {
      return jsonError('Site access denied', 403);
    }

    const hash = getPromptHash(`v2:${siteId}:${promptStr}`);
    const cached = await downloadFromCache(hash);
    if (cached) {
      return NextResponse.json(
        { summary: cached },
        { headers: { 'Cache-Control': 'private, max-age=31536000, immutable' } }
      );
    }

    const lockKey = `lock:public-summary:${hash}`;
    const lock = await acquireLock(lockKey, 180);
    if (lock.state === 'contended') {
      return jsonError('Summary generation is already in progress', 409);
    }
    if (lock.state !== 'acquired') {
      return jsonError('Summary generation admission is unavailable', 503);
    }
    try {
      const rechecked = await downloadFromCache(hash);
      if (rechecked) {
        return NextResponse.json(
          { summary: rechecked },
          { headers: { 'Cache-Control': 'private, max-age=31536000, immutable' } },
        );
      }
      const result = await SummaryGenerationService.summarize({
        text: promptStr,
        site_id: siteId
      });
      if (!result.success || !result.summary) {
        return jsonError('Summary generation failed', 502, result.error);
      }
      await uploadToCache(hash, result.summary);
      return NextResponse.json(
        { summary: result.summary },
        { headers: { 'Cache-Control': 'private, max-age=31536000, immutable' } }
      );
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  } catch (error: any) {
    console.error('[PublicPromptSummary] Unhandled error:', error);
    return jsonError('Internal server error', 500, error?.message || String(error));
  }
}
