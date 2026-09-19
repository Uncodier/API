import { NextRequest, NextResponse } from 'next/server'
import { visitorTrackingEventSchema } from '@/lib/validation/visitor-tracking-event'
import {
  prepareTrackingEvents,
  trackingRequestContext,
} from '@/lib/services/tracking-event-ingest'
import { enqueueTrackingEvents } from '@/lib/services/tracking-event-queue'

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

  try {
    const [event] = prepareTrackingEvents(
      [validationResult.data],
      trackingRequestContext(request),
    );
    const messageId = await enqueueTrackingEvents([event]);

    return NextResponse.json({
      success: true,
      event_id: event.id,
      visitor_id: event.visitor_id,
      lead_id: null,
      session_id: event.session_id,
      segment_id: event.segment_id,
      timestamp: event.timestamp,
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