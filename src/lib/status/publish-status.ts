import { getSupabaseServiceRoleUrl } from '@/lib/database/supabase-client';
import type { PublicStatusSummary } from '@/lib/status/get-public-summary';
import { sanitizePublicPayload } from '@/lib/status/types';

/** Public Realtime broadcast topic. Not postgres_changes on the tables. */
export const SYSTEM_STATUS_CHANNEL = 'system-status';
export const SYSTEM_STATUS_BROADCAST_EVENT = 'status';

export function buildStatusBroadcastBody(payload: PublicStatusSummary): string {
  return JSON.stringify({
    messages: [
      {
        topic: SYSTEM_STATUS_CHANNEL,
        event: SYSTEM_STATUS_BROADCAST_EVENT,
        payload: sanitizePublicPayload(payload),
      },
    ],
  });
}

/**
 * Publish a sanitized status snapshot to the public Realtime broadcast channel.
 * Uses the HTTP broadcast API so serverless/CI does not open a websocket.
 * Failures are logged and never thrown — persist remains the source of truth.
 */
export async function publishSystemStatus(payload: PublicStatusSummary): Promise<boolean> {
  const baseUrl = getSupabaseServiceRoleUrl().replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!baseUrl || !serviceKey) {
    console.warn('[system-status] broadcast skipped: missing Supabase URL or service role key');
    return false;
  }

  try {
    const res = await fetch(`${baseUrl}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: buildStatusBroadcastBody(payload),
    });
    if (!res.ok) {
      console.warn('[system-status] broadcast HTTP', res.status);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[system-status] broadcast failed:', error);
    return false;
  }
}
