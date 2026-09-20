import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  detectScreenSize,
  extractRequestInfoWithLocation,
} from '@/lib/utils/request-info-extractor';
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit';
import {
  canAccessSite,
  originBelongsToSite,
} from '@/lib/security/site-access';
import {
  verifyVisitorSessionToken,
  visitorSessionTokenFromRequest,
} from '@/lib/security/visitor-session-token';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export const createSessionSchema = z.object({
  site_id: z.string().uuid('site_id must be a valid UUID'),
  id: z.string().uuid('id must be a valid UUID').optional(),
  fingerprint: z.string().max(512).optional(),
  url: z.string().url('url must be valid').optional(),
  referrer: z.string().max(2_048).optional(),
  utm_source: z.string().max(512).optional(),
  utm_medium: z.string().max(512).optional(),
  utm_campaign: z.string().max(512).optional(),
  utm_term: z.string().max(512).optional(),
  utm_content: z.string().max(512).optional(),
  device: z.object({
    type: z.string().max(100).optional(),
    screen_size: z.string().max(100).optional(),
    os: z.object({
      name: z.string().max(100).optional(),
      version: z.string().max(100).optional(),
    }).optional(),
    pixel_ratio: z.number().optional(),
    orientation: z.string().max(100).optional(),
    memory: z.number().optional(),
    cpu_cores: z.number().optional(),
    touch_support: z.boolean().optional(),
  }).optional(),
  browser: z.object({
    name: z.string().max(100).optional(),
    version: z.string().max(100).optional(),
    language: z.string().max(100).optional(),
  }).optional(),
  location: z.object({
    country: z.string().max(100).optional(),
    region: z.string().max(100).optional(),
    city: z.string().max(100).optional(),
  }).optional(),
  previous_session_id: z.string().uuid().optional(),
  performance: z.object({
    page_load_time: z.number().optional(),
    first_paint: z.number().optional(),
    first_contentful_paint: z.number().optional(),
    dom_interactive: z.number().optional(),
  }).optional(),
  consent: z.object({
    necessary: z.boolean().optional(),
    analytics: z.boolean().optional(),
    marketing: z.boolean().optional(),
    preferences: z.boolean().optional(),
  }).optional(),
});

export const updateSessionSchema = z.object({
  session_id: z.string().uuid('session_id must be a valid UUID'),
  site_id: z.string().uuid('site_id must be a valid UUID'),
  last_activity_at: z.number().optional(),
  current_url: z.string().url('current_url must be valid').optional(),
  page_views: z.number().int().nonnegative().optional(),
  active_time: z.number().int().nonnegative().optional(),
  custom_data: z.record(z.any()).optional(),
});

export const getSessionParamsSchema = z.object({
  session_id: z.string().uuid('session_id must be a valid UUID'),
  site_id: z.string().uuid('site_id must be a valid UUID'),
});

export function sessionErrorResponse(
  message: string,
  status = 400,
  details: unknown = null,
) {
  return NextResponse.json({
    success: false,
    error: {
      code: status === 404 ? 'not_found' : 'bad_request',
      message,
      details,
      request_id: uuidv4(),
    },
  }, { status });
}

export async function authorizeNewSession(
  request: NextRequest,
  siteId: string,
): Promise<boolean> {
  return hasAuthenticatedPrincipal(request)
    ? canAccessSite(request, siteId)
    : originBelongsToSite(request, siteId);
}

export async function authorizeExistingSession(
  request: NextRequest,
  siteId: string,
  sessionId: string,
): Promise<boolean> {
  if (hasAuthenticatedPrincipal(request)) {
    return canAccessSite(request, siteId);
  }
  return verifyVisitorSessionToken(
    visitorSessionTokenFromRequest(request),
    { siteId, sessionId },
  );
}

export async function canReuseVisitorIdentity(
  request: NextRequest,
  siteId: string,
  visitorId: string,
  previousSessionId?: string,
): Promise<boolean> {
  if (!previousSessionId) return false;
  const authorized = hasAuthenticatedPrincipal(request)
    ? await canAccessSite(request, siteId)
    : await verifyVisitorSessionToken(
        visitorSessionTokenFromRequest(request),
        {
          siteId,
          sessionId: previousSessionId,
          visitorId,
        },
      );
  if (!authorized) return false;
  const { data, error } = await supabaseAdmin
    .from('visitor_sessions')
    .select('id')
    .eq('id', previousSessionId)
    .eq('site_id', siteId)
    .eq('visitor_id', visitorId)
    .maybeSingle();
  return !error && Boolean(data);
}

export async function prepareSessionData(
  sessionData: z.infer<typeof createSessionSchema>,
  sessionId: string,
  visitorId: string,
  startTime: number,
  request: NextRequest,
) {
  try {
    const requestInfo = await extractRequestInfoWithLocation(request);
    const device = sessionData.device || {
      type: requestInfo.device.type,
      screen_size: detectScreenSize(requestInfo.userAgent),
      os: requestInfo.device.os,
      touch_support: requestInfo.device.touch_support,
    };
    device.type ||= requestInfo.device.type;
    device.screen_size ||= detectScreenSize(requestInfo.userAgent);
    device.os ||= requestInfo.device.os;
    if (device.touch_support === undefined) {
      device.touch_support = requestInfo.device.touch_support;
    }

    const browser = sessionData.browser || {
      name: requestInfo.browser.name,
      version: requestInfo.browser.version,
      language: requestInfo.browser.language,
    };
    browser.name ||= requestInfo.browser.name;
    browser.version ||= requestInfo.browser.version;
    browser.language ||= requestInfo.browser.language;

    const location = sessionData.location || {
      country: requestInfo.location.country,
      region: requestInfo.location.region,
      city: requestInfo.location.city,
    };
    location.country ||= requestInfo.location.country;
    location.region ||= requestInfo.location.region;
    location.city ||= requestInfo.location.city;

    return {
      valid: true as const,
      error: null,
      data: {
        id: sessionId,
        visitor_id: visitorId,
        site_id: sessionData.site_id,
        landing_url: sessionData.url || null,
        current_url: sessionData.url || null,
        referrer: sessionData.referrer || null,
        utm_source: sessionData.utm_source || null,
        utm_medium: sessionData.utm_medium || null,
        utm_campaign: sessionData.utm_campaign || null,
        utm_term: sessionData.utm_term || null,
        utm_content: sessionData.utm_content || null,
        started_at: startTime,
        last_activity_at: startTime,
        page_views: 1,
        device,
        browser,
        location,
        previous_session_id: sessionData.previous_session_id || null,
        performance: sessionData.performance || null,
        consent: sessionData.consent || null,
        is_active: true,
      },
    };
  } catch (error) {
    return {
      valid: false as const,
      error: error instanceof Error ? error.message : 'Invalid session data',
      data: null,
    };
  }
}
