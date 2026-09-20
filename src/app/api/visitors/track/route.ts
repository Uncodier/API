import { NextRequest, NextResponse } from 'next/server'
import { visitorTrackingEventSchema } from '@/lib/validation/visitor-tracking-event'
import {
  prepareTrackingEvents,
  trackingRequestContext,
} from '@/lib/services/tracking-event-ingest'
import { enqueueTrackingEvents } from '@/lib/services/tracking-event-queue'
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit'
import {
  canAccessSite,
  originBelongsToSite,
} from '@/lib/security/site-access'
import {
  verifiedVisitorSessionClaims,
  visitorSessionTokenFromRequest,
} from '@/lib/security/visitor-session-token'

function errorResponse(message: string, status: number, details?: unknown) {
  return NextResponse.json(
    {
      success: false,
      error: {
        message,
        details
      }
    },
    { status }
  );
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const validationResult = visitorTrackingEventSchema.safeParse(body);
  if (!validationResult.success) {
    return errorResponse(
      'Invalid tracking event',
      400,
      validationResult.error.format(),
    );
  }
  const siteId = validationResult.data.site_id;
  const authenticated = hasAuthenticatedPrincipal(request);
  let event = validationResult.data;
  let authorized: boolean;
  if (authenticated) {
    authorized = await canAccessSite(request, siteId);
  } else if (event.session_id) {
    const claims = await verifiedVisitorSessionClaims(
          visitorSessionTokenFromRequest(request),
          {
            siteId,
            sessionId: event.session_id,
            visitorId: event.visitor_id || event.id,
          },
        );
    authorized = Boolean(claims);
    if (claims) {
      event = {
        ...event,
        id: undefined,
        session_id: claims.sessionId,
        visitor_id: claims.visitorId,
      };
    }
  } else {
    authorized = await originBelongsToSite(request, siteId);
    event = {
      ...event,
      id: undefined,
      visitor_id: undefined,
      segment_id: undefined,
    };
  }
  if (!authorized) {
    return errorResponse('Site access denied', 403);
  }

  try {
    const [queuedEvent] = prepareTrackingEvents(
      [event],
      trackingRequestContext(request),
    );
    const messageId = await enqueueTrackingEvents([queuedEvent]);

    return NextResponse.json({
      success: true,
      event_id: queuedEvent.id,
      visitor_id: queuedEvent.visitor_id,
      lead_id: null,
      session_id: queuedEvent.session_id,
      segment_id: queuedEvent.segment_id,
      timestamp: queuedEvent.timestamp,
      queue_message_id: messageId,
      queued: true,
    }, { status: 202 });
  } catch (error: unknown) {
    console.error('[POST /api/visitors/track] Queue error:', error);
    return errorResponse(
      'Tracking queue is temporarily unavailable',
      503,
      error instanceof Error ? error.message : String(error),
    );
  }
}