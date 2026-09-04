import { NextRequest, NextResponse } from 'next/server';
import { getPromptHash, downloadFromCache, uploadToCache } from '@/lib/services/summary/promptSummaryCache';
import { resolveSiteFromRequirementUrl } from '@/lib/services/image/resolveSiteFromRequirementUrl';
import { SummaryGenerationService } from '@/lib/services/summary/SummaryGenerationService';

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

    const hash = getPromptHash(promptStr);

    // 1. Cache hit → return summary
    const cached = await downloadFromCache(hash);
    if (cached) {
      return NextResponse.json(
        { summary: cached },
        { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }
      );
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
    } else {
      siteId = await resolveSiteFromRequirementUrl(originOrReferer);
    }

    if (!siteId) {
      return jsonError('Domain not authorized for summary generation', 403);
    }

    // 3. Generate summary
    const result = await SummaryGenerationService.summarize({
      text: promptStr,
      site_id: siteId
    });

    if (!result.success || !result.summary) {
      return jsonError('Summary generation failed', 502, result.error);
    }

    // 4. Cache it
    await uploadToCache(hash, result.summary).catch((err) => {
      console.warn('[PublicPromptSummary] Failed to cache summary:', err);
    });

    // 5. Return summary
    return NextResponse.json(
      { summary: result.summary },
      { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }
    );
  } catch (error: any) {
    console.error('[PublicPromptSummary] Unhandled error:', error);
    return jsonError('Internal server error', 500, error?.message || String(error));
  }
}
