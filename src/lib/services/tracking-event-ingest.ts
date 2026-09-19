import { v4 as uuidv4 } from 'uuid';
import type { VisitorTrackingEvent } from '@/lib/validation/visitor-tracking-event';

export interface QueuedTrackingEvent {
  id: string;
  site_id: string;
  event_type: string;
  event_name: string | null;
  url: string;
  referrer: string | null;
  visitor_id: string | null;
  session_id: string | null;
  segment_id: string | null;
  timestamp: number;
  properties: Record<string, unknown>;
  user_agent: string | null;
  ip: string | null;
  data: Record<string, unknown>;
}

export function trackingRequestContext(request: Request): {
  ip?: string;
  userAgent?: string;
} {
  const forwardedFor = request.headers.get('x-forwarded-for');
  return {
    ip:
      forwardedFor?.split(',')[0]?.trim()
      || request.headers.get('x-real-ip')
      || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
  };
}

export function prepareTrackingEvents(
  events: VisitorTrackingEvent[],
  context: { ip?: string; userAgent?: string },
): QueuedTrackingEvent[] {
  return events.map((event) => {
    const timestamp = Math.trunc(event.timestamp || Date.now());
    const ip = context.ip || event.ip || null;
    const userAgent = context.userAgent || event.user_agent || null;

    return {
      id: event.event_id || uuidv4(),
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
      user_agent: userAgent,
      ip,
      data: {
        ...event,
        timestamp,
        user_agent: userAgent,
        ip,
      },
    };
  });
}
