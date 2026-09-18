import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { visitorTrackingEventSchema } from '@/lib/validation/visitor-tracking-event';

const requestSchema = z.union([
  z.array(visitorTrackingEventSchema).min(1).max(100),
  z.object({
    events: z.array(visitorTrackingEventSchema).min(1).max(100),
  }),
]);

function errorResponse(message: string, status: number, details?: unknown) {
  return NextResponse.json(
    { success: false, error: { message, details } },
    { status },
  );
}

export async function POST(request: NextRequest) {
  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse(
        'Invalid tracking event batch',
        400,
        parsed.error.format(),
      );
    }

    const events = Array.isArray(parsed.data)
      ? parsed.data
      : parsed.data.events;
    const forwardedFor = request.headers.get('x-forwarded-for');
    const requestIp =
      forwardedFor?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      undefined;
    const requestUserAgent =
      request.headers.get('user-agent') || undefined;

    const sessionRows = new Map<string, Record<string, unknown>>();
    for (const event of events) {
      const visitorId = event.visitor_id || event.id;
      if (!event.session_id || !visitorId) continue;
      if (sessionRows.has(event.session_id)) continue;
      const timestamp = Math.trunc(event.timestamp || Date.now());
      sessionRows.set(event.session_id, {
        id: event.session_id,
        visitor_id: visitorId,
        site_id: event.site_id,
        landing_url: event.url,
        current_url: event.url,
        referrer: event.referrer || null,
        started_at: timestamp,
        last_activity_at: timestamp,
        page_views: 1,
        is_active: true,
      });
    }

    if (sessionRows.size > 0) {
      const { error: sessionError } = await supabaseAdmin
        .from('visitor_sessions')
        .upsert(Array.from(sessionRows.values()), {
          onConflict: 'id',
          ignoreDuplicates: true,
        });
      if (sessionError) {
        return errorResponse(
          'Failed to initialize tracking sessions',
          500,
          sessionError,
        );
      }
    }

    const rows = events.map((event) => {
      const id = uuidv4();
      const timestamp = Math.trunc(event.timestamp || Date.now());
      return {
        id,
        site_id: event.site_id,
        event_type: event.event_type,
        event_name: 'event_name' in event ? event.event_name : null,
        url: event.url,
        referrer: event.referrer || null,
        visitor_id: event.visitor_id || event.id || null,
        session_id: event.session_id || null,
        segment_id: event.segment_id || null,
        timestamp,
        properties: event.properties || {},
        user_agent: requestUserAgent || event.user_agent || null,
        ip: requestIp || event.ip || null,
        data: {
          ...event,
          timestamp,
          user_agent: requestUserAgent || event.user_agent || null,
          ip: requestIp || event.ip || null,
        },
      };
    });

    const { error } = await supabaseAdmin.from('session_events').insert(rows);
    if (error) {
      return errorResponse('Failed to persist tracking events', 500, error);
    }

    return NextResponse.json({
      success: true,
      accepted: rows.length,
      event_ids: rows.map((row) => row.id),
    });
  } catch (error: unknown) {
    return errorResponse(
      'Internal tracking error',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
