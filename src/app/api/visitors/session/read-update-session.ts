import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  authorizeExistingSession,
  getSessionParamsSchema,
  sessionErrorResponse,
  updateSessionSchema,
} from './session-shared';
import {
  cacheVisitorSession,
  readCachedVisitorSession,
  readVisitorHeartbeat,
  recordVisitorHeartbeat,
} from '@/lib/services/visitor-session-live-state';

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const parsed = getSessionParamsSchema.safeParse({
      session_id: url.searchParams.get('session_id'),
      site_id: url.searchParams.get('site_id'),
    });
    if (!parsed.success) {
      return sessionErrorResponse(
        'Invalid session parameters',
        400,
        parsed.error.format(),
      );
    }
    const { session_id: sessionId, site_id: siteId } = parsed.data;
    if (!await authorizeExistingSession(request, siteId, sessionId)) {
      return sessionErrorResponse('Session authorization failed', 403);
    }

    const startTime = Date.now();
    let session = await readCachedVisitorSession<any>(siteId, sessionId);
    if (!session) {
      const { data, error } = await supabaseAdmin
        .from('visitor_sessions')
        .select('*, visitors(fingerprint)')
        .eq('id', sessionId)
        .eq('site_id', siteId)
        .eq('is_active', true)
        .single();
      if (error || !data) {
        return sessionErrorResponse(
          'Session not found or expired',
          404,
          { session_id: sessionId, site_id: siteId },
        );
      }
      session = data;
      await cacheVisitorSession(siteId, sessionId, session);
    }
    session = {
      ...session,
      ...await readVisitorHeartbeat(siteId, sessionId),
    };

    const { data: events, error: eventsError } = await supabaseAdmin
      .from('visitor_events')
      .select('*')
      .eq('session_id', sessionId)
      .order('timestamp', { ascending: true })
      .limit(1_000);

    return NextResponse.json({
      success: true,
      data: {
        session_id: session.id,
        visitor_id: session.visitor_id,
        fingerprint: session.visitors?.fingerprint || null,
        id: session.visitor_id,
        lead_id: session.lead_id,
        site_id: session.site_id,
        url: session.landing_url,
        current_url: session.current_url,
        referrer: session.referrer,
        utm_source: session.utm_source,
        utm_medium: session.utm_medium,
        utm_campaign: session.utm_campaign,
        started_at: session.started_at,
        last_activity_at: session.last_activity_at,
        duration: session.duration,
        page_views: session.page_views,
        active_time: session.active_time,
        idle_time: session.idle_time,
        events: eventsError ? [] : events,
      },
      meta: {
        api_version: '1.0',
        server_time: Date.now(),
        processing_time: Date.now() - startTime,
      },
    });
  } catch (error) {
    console.error('[Visitor Session] Read failed:', error);
    return sessionErrorResponse(
      error instanceof Error ? error.message : 'Unable to read session',
      500,
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const parsed = updateSessionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return sessionErrorResponse(
        'Invalid request data',
        400,
        parsed.error.format(),
      );
    }
    const update = parsed.data;
    if (!await authorizeExistingSession(
      request,
      update.site_id,
      update.session_id,
    )) {
      return sessionErrorResponse('Session authorization failed', 403);
    }

    const startTime = Date.now();
    let existing = await readCachedVisitorSession<any>(
      update.site_id,
      update.session_id,
    );
    if (!existing) {
      const { data, error } = await supabaseAdmin
        .from('visitor_sessions')
        .select('*, visitors(fingerprint)')
        .eq('id', update.session_id)
        .eq('site_id', update.site_id)
        .eq('is_active', true)
        .single();
      if (error || !data) {
        return sessionErrorResponse('Session not found or expired', 404);
      }
      existing = data;
      await cacheVisitorSession(update.site_id, update.session_id, existing);
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (update.last_activity_at !== undefined) {
      updates.last_activity_at = update.last_activity_at;
      updates.duration = Math.max(
        0,
        update.last_activity_at - (existing.started_at || update.last_activity_at),
      );
    }
    if (update.current_url !== undefined) updates.current_url = update.current_url;
    if (update.page_views !== undefined) updates.page_views = update.page_views;
    if (update.active_time !== undefined) updates.active_time = update.active_time;
    if (update.custom_data !== undefined) updates.custom_data = update.custom_data;

    const heartbeat = await recordVisitorHeartbeat(
      update.site_id,
      update.session_id,
      updates,
    );
    if (heartbeat?.closed) {
      return sessionErrorResponse('Session not found or expired', 404);
    }
    const persistedUpdates = heartbeat?.state ?? updates;
    if (!heartbeat || heartbeat.shouldPersist) {
      const { data: persisted, error } = await supabaseAdmin
        .from('visitor_sessions')
        .update(persistedUpdates)
        .eq('id', update.session_id)
        .eq('site_id', update.site_id)
        .eq('is_active', true)
        .select('id')
        .maybeSingle();
      if (error || !persisted) {
        return sessionErrorResponse(
          error
            ? `Unable to update session: ${error.message}`
            : 'Session not found or expired',
          error ? 500 : 404,
        );
      }
    }
    await cacheVisitorSession(update.site_id, update.session_id, {
      ...existing,
      ...persistedUpdates,
    });

    const ttl = 1_800;
    return NextResponse.json({
      success: true,
      data: {
        session_id: update.session_id,
        visitor_id: existing.visitor_id,
        fingerprint: existing.visitors?.fingerprint || null,
        id: existing.visitor_id,
        lead_id: existing.lead_id,
        updated_at: Date.now(),
        expires_at: Date.now() + ttl * 1_000,
        ttl,
      },
      meta: {
        api_version: '1.0',
        server_time: Date.now(),
        processing_time: Date.now() - startTime,
      },
    });
  } catch (error) {
    console.error('[Visitor Session] Update failed:', error);
    return sessionErrorResponse(
      error instanceof Error ? error.message : 'Unable to update session',
      500,
    );
  }
}
