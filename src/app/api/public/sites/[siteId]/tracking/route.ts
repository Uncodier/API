import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { originBelongsToSite } from '@/lib/security/site-access';
import {
  getCachedJson,
  setCachedJson,
} from '@/lib/security/upstash-rest';

const paramsSchema = z.object({
  siteId: z.string().uuid(),
});

type TrackingRecord = Record<string, unknown>;

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeConfig(
  siteId: string,
  tracking: TrackingRecord,
  website: TrackingRecord,
) {
  const source = { ...tracking, ...website };
  const privacy = (
    tracking.privacy && typeof tracking.privacy === 'object'
      ? tracking.privacy
      : {}
  ) as TrackingRecord;
  const position = stringValue(source.chat_position);

  return {
    site_id: siteId,
    track_visitors: booleanValue(source.track_visitors),
    track_actions: booleanValue(source.track_actions),
    record_screen: booleanValue(source.record_screen),
    chat: {
      enabled: booleanValue(source.enable_chat),
      accent_color: stringValue(source.chat_accent_color),
      position: ['bottom-right', 'bottom-left', 'top-right', 'top-left']
        .includes(position || '')
        ? position
        : 'bottom-right',
      title: stringValue(source.chat_title),
      welcome_message: stringValue(source.welcome_message),
      allow_anonymous_messages: booleanValue(
        source.allow_anonymous_messages,
      ),
    },
    cookie_consent: booleanValue(
      website.show_cookie_consent,
      booleanValue(privacy.cookie_consent),
    ),
  };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ siteId: string }> },
) {
  try {
    const { siteId } = paramsSchema.parse(await context.params);
    const cacheKey = `cache:public-tracking-config:${siteId}`;
    const cached = await getCachedJson<{
      siteUrl: string | null;
      data: ReturnType<typeof normalizeConfig>;
    }>(cacheKey);
    const origin = request.headers.get('origin');
    if (cached) {
      if (
        origin
        && !await originBelongsToSite(request, siteId, cached.siteUrl)
      ) {
        return NextResponse.json(
          { success: false, error: { code: 'origin_not_allowed' } },
          { status: 403 },
        );
      }
      return NextResponse.json(
        { success: true, data: cached.data },
        { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' } },
      );
    }

    const { data: site, error: siteError } = await supabaseAdmin
      .from('sites')
      .select('id, url, tracking')
      .eq('id', siteId)
      .maybeSingle();

    if (siteError) {
      console.error('[Public tracking config] Site lookup failed:', siteError);
      return NextResponse.json(
        { success: false, error: { code: 'site_fetch_error' } },
        { status: 500 },
      );
    }
    if (!site) {
      return NextResponse.json(
        { success: false, error: { code: 'site_not_found' } },
        { status: 404 },
      );
    }

    if (
      origin
      && !await originBelongsToSite(request, siteId, site.url)
    ) {
      return NextResponse.json(
        { success: false, error: { code: 'origin_not_allowed' } },
        { status: 403 },
      );
    }

    const { data: settings, error: settingsError } = await supabaseAdmin
      .from('settings')
      .select('channels')
      .eq('site_id', siteId)
      .maybeSingle();
    if (settingsError) {
      console.error(
        '[Public tracking config] Settings lookup failed:',
        settingsError,
      );
    }

    const channels = (
      settings?.channels && typeof settings.channels === 'object'
        ? settings.channels
        : {}
    ) as Record<string, unknown>;
    const website = (
      channels.website && typeof channels.website === 'object'
        ? channels.website
        : {}
    ) as TrackingRecord;
    const normalized = normalizeConfig(
      siteId,
      (site.tracking || {}) as TrackingRecord,
      website,
    );
    await setCachedJson(
      cacheKey,
      { siteUrl: site.url || null, data: normalized },
      60,
    );

    return NextResponse.json(
      {
        success: true,
        data: normalized,
      },
      {
        headers: {
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
        },
      },
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: { code: 'invalid_site_id' } },
        { status: 400 },
      );
    }
    console.error('[Public tracking config] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: { code: 'internal_error' } },
      { status: 500 },
    );
  }
}
