import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { visitorTrackingEventSchema } from '@/lib/validation/visitor-tracking-event';
import {
  prepareTrackingEvents,
  trackingRequestContext,
} from '@/lib/services/tracking-event-ingest';
import { enqueueTrackingEvents } from '@/lib/services/tracking-event-queue';

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
    const queuedEvents = prepareTrackingEvents(
      events,
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
