import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { enforceRequestRateLimit } from '@/lib/security/request-rate-limit';
import { issueVisitorSessionToken } from '@/lib/security/visitor-session-token';
import {
  authorizeNewSession,
  canReuseVisitorIdentity,
  createSessionSchema,
  prepareSessionData,
  sessionErrorResponse,
} from './session-shared';
import { closeVisitorLiveState } from '@/lib/services/visitor-session-live-state';

async function closePreviousSession(
  visitorId: string,
  siteId: string,
  now: number,
): Promise<string | null> {
  const { data: previous } = await supabaseAdmin
    .from('visitor_sessions')
    .select('id, is_active, started_at, active_time')
    .eq('visitor_id', visitorId)
    .eq('site_id', siteId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!previous) return null;

  if (previous.is_active) {
    const duration = Math.max(0, now - previous.started_at);
    const activeTime = Math.max(0, previous.active_time || 0);
    const { error } = await supabaseAdmin
      .from('visitor_sessions')
      .update({
        is_active: false,
        duration,
        idle_time: Math.max(0, duration - activeTime),
        exit_type: 'new_session',
        updated_at: new Date().toISOString(),
      })
      .eq('id', previous.id);
    if (error) {
      throw new Error(`Unable to close previous session: ${error.message}`);
    }
    await closeVisitorLiveState(siteId, previous.id);
  }
  return previous.id;
}

async function createOrUpdateVisitor(input: {
  visitorId: string;
  siteId: string;
  fingerprint?: string;
  startTime: number;
  url?: string;
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
}) {
  const { data: existing } = await supabaseAdmin
    .from('visitors')
    .select('id')
    .eq('id', input.visitorId)
    .maybeSingle();

  if (!existing) {
    const { error } = await supabaseAdmin.from('visitors').insert([{
      id: input.visitorId,
      fingerprint: input.fingerprint || null,
      first_seen_at: input.startTime,
      last_seen_at: input.startTime,
      total_sessions: 1,
      total_page_views: 1,
      total_time_spent: 0,
      first_url: input.url || null,
      first_referrer: input.referrer || null,
      first_utm_source: input.utm_source || null,
      first_utm_medium: input.utm_medium || null,
      first_utm_campaign: input.utm_campaign || null,
      first_utm_term: input.utm_term || null,
      first_utm_content: input.utm_content || null,
      is_identified: false,
    }]);
    if (error) throw new Error(`Unable to create visitor: ${error.message}`);
    return;
  }

  const { error: incrementError } = await supabaseAdmin.rpc(
    'increment_visitor_sessions',
    {
      visitor_id: input.visitorId,
      last_seen_timestamp: input.startTime,
    },
  );
  if (!incrementError) return;

  const { data: current, error: fetchError } = await supabaseAdmin
    .from('visitors')
    .select('total_sessions')
    .eq('id', input.visitorId)
    .single();
  if (fetchError || !current) {
    throw new Error('Unable to update visitor session count');
  }
  const { error: updateError } = await supabaseAdmin
    .from('visitors')
    .update({
      last_seen_at: input.startTime,
      total_sessions: (current.total_sessions || 0) + 1,
    })
    .eq('id', input.visitorId);
  if (updateError) throw new Error(`Unable to update visitor: ${updateError.message}`);
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  try {
    const parsed = createSessionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return sessionErrorResponse(
        'Invalid request data',
        400,
        parsed.error.format(),
      );
    }
    const sessionData = parsed.data;
    const limited = await enforceRequestRateLimit(request, {
      namespace: `visitor-session-create:${sessionData.site_id}`,
      limit: 20,
      windowSeconds: 60,
      failClosed: true,
    });
    if (limited) return limited;
    const globallyLimited = await enforceRequestRateLimit(request, {
      namespace: 'visitor-session-create-global',
      identity: 'global',
      limit: Math.max(
        1,
        Number(process.env.VISITOR_SESSION_GLOBAL_REQUESTS_PER_MINUTE) || 500,
      ),
      windowSeconds: 60,
      failClosed: true,
    });
    if (globallyLimited) return globallyLimited;
    if (!await authorizeNewSession(request, sessionData.site_id)) {
      return sessionErrorResponse('Site access denied', 403);
    }

    const sessionId = uuidv4();
    const requestedVisitorId = sessionData.id
      && await canReuseVisitorIdentity(
        request,
        sessionData.site_id,
        sessionData.id,
        sessionData.previous_session_id,
      )
      ? sessionData.id
      : undefined;
    const visitorId = requestedVisitorId || uuidv4();
    const previousSessionId = await closePreviousSession(
      visitorId,
      sessionData.site_id,
      startTime,
    );
    const prepared = await prepareSessionData(
      sessionData,
      sessionId,
      visitorId,
      startTime,
      request,
    );
    if (!prepared.valid || !prepared.data) {
      return sessionErrorResponse(
        `Unable to prepare session data: ${prepared.error}`,
      );
    }
    prepared.data.previous_session_id = previousSessionId;

    await createOrUpdateVisitor({
      visitorId,
      siteId: sessionData.site_id,
      startTime,
      fingerprint: sessionData.fingerprint,
      url: sessionData.url,
      referrer: sessionData.referrer,
      utm_source: sessionData.utm_source,
      utm_medium: sessionData.utm_medium,
      utm_campaign: sessionData.utm_campaign,
      utm_term: sessionData.utm_term,
      utm_content: sessionData.utm_content,
    });

    const { data, error } = await supabaseAdmin
      .from('visitor_sessions')
      .insert([prepared.data])
      .select()
      .single();
    if (error || !data) {
      return sessionErrorResponse(
        `Unable to create session: ${error?.message || 'No confirmation returned'}`,
        500,
      );
    }

    const ttl = 1_800;
    const sessionToken = await issueVisitorSessionToken({
      siteId: sessionData.site_id,
      sessionId,
      visitorId,
    }, ttl);
    return NextResponse.json({
      success: true,
      data: {
        session_id: sessionId,
        visitor_id: visitorId,
        fingerprint: sessionData.fingerprint || null,
        id: visitorId,
        lead_id: null,
        created_at: startTime,
        expires_at: startTime + ttl * 1_000,
        ttl,
        session_token: sessionToken,
        session_url:
          `/api/visitors/session?session_id=${sessionId}&site_id=${sessionData.site_id}`,
        is_new_session: true,
      },
      meta: {
        api_version: '1.0',
        server_time: Date.now(),
        processing_time: Date.now() - startTime,
      },
    }, { status: 201 });
  } catch (error) {
    console.error('[Visitor Session] Creation failed:', error);
    return sessionErrorResponse(
      error instanceof Error ? error.message : 'Unable to create session',
      500,
    );
  }
}
