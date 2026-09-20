import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { visitorTrackingEventSchema } from '@/lib/validation/visitor-tracking-event';
import {
  prepareTrackingEvents,
  trackingRequestContext,
} from '@/lib/services/tracking-event-ingest';
import { enqueueTrackingEvents } from '@/lib/services/tracking-event-queue';
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit';
import {
  canAccessSite,
  originBelongsToSite,
} from '@/lib/security/site-access';
import {
  verifiedVisitorSessionClaims,
  visitorSessionTokenFromRequest,
} from '@/lib/security/visitor-session-token';

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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      'Invalid tracking event batch',
      400,
      parsed.error.format(),
    );
  }

  try {
    const events = Array.isArray(parsed.data)
      ? parsed.data
      : parsed.data.events;
    const siteIds = new Set(events.map((event) => event.site_id));
    if (siteIds.size !== 1) {
      return errorResponse('All tracking events must belong to one site', 400);
    }
    const siteId = events[0].site_id;
    const sessionIds = new Set(
      events
        .map((event) => event.session_id)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
    if (sessionIds.size > 1) {
      return errorResponse('All session events must belong to one session', 400);
    }
    const sessionEventCount = events.filter((event) => event.session_id).length;
    if (sessionEventCount > 0 && sessionEventCount !== events.length) {
      return errorResponse('Session and sessionless events cannot be mixed', 400);
    }
    const sessionId = Array.from(sessionIds)[0];
    const visitorIds = new Set(
      events
        .map((event) => event.visitor_id || event.id)
        .filter((visitorId): visitorId is string => Boolean(visitorId)),
    );
    if (visitorIds.size > 1) {
      return errorResponse('All tracking events must belong to one visitor', 400);
    }
    const visitorId = Array.from(visitorIds)[0];
    const authenticated = hasAuthenticatedPrincipal(request);
    let admittedEvents = events;
    let authorized: boolean;
    if (authenticated) {
      authorized = await canAccessSite(request, siteId);
    } else if (sessionId) {
      const claims = await verifiedVisitorSessionClaims(
            visitorSessionTokenFromRequest(request),
            { siteId, sessionId, visitorId },
          );
      authorized = Boolean(claims);
      if (claims) {
        admittedEvents = events.map((event) => ({
          ...event,
          id: undefined,
          session_id: claims.sessionId,
          visitor_id: claims.visitorId,
        }));
      }
    } else {
      authorized = await originBelongsToSite(request, siteId);
      admittedEvents = events.map((event) => ({
        ...event,
        id: undefined,
        visitor_id: undefined,
        segment_id: undefined,
      }));
    }
    if (!authorized) {
      return errorResponse('Site access denied', 403);
    }
    const queuedEvents = prepareTrackingEvents(
      admittedEvents,
      trackingRequestContext(request),
    );
    const messageId = await enqueueTrackingEvents(queuedEvents);

    return NextResponse.json({
      success: true,
      accepted: queuedEvents.length,
      event_ids: queuedEvents.map((event) => event.id),
      queue_message_id: messageId,
      queued: true,
    }, { status: 202 });
  } catch (error: unknown) {
    console.error('[POST /api/visitors/track-batch] Queue error:', error);
    return errorResponse(
      'Tracking queue is temporarily unavailable',
      503,
      error instanceof Error ? error.message : String(error),
    );
  }
}
