import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { SystemHealthStatus } from './types';

export const REDIS_TELEMETRY_KEYS = {
  tracking: 'redis_tracking_queue',
  recordings: 'redis_recording_queue',
} as const;

export interface TelemetryRecord {
  status: SystemHealthStatus;
  message: string;
  latency_ms: number;
  created_at: string;
}

/**
 * Retrieves the latest telemetry record for a system key, 
 * looking back up to the specified hours (default 24).
 * Returns null if no record is found in that window.
 */
export async function getLatestTelemetry(
  systemKey: string,
  hoursMax: number = 24
): Promise<TelemetryRecord | null> {
  try {
    const since = new Date(Date.now() - hoursMax * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('system_telemetry')
      .select('status, message, latency_ms, created_at')
      .eq('system_key', systemKey)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error(`[Telemetry] getLatestTelemetry error for ${systemKey}:`, error);
      return null;
    }
    if (!data) {
      return null;
    }
    return data as TelemetryRecord;
  } catch (err) {
    console.error(`[Telemetry] Exception in getLatestTelemetry for ${systemKey}:`, err);
    return null;
  }
}

/**
 * Records passive telemetry for a given system.
 * This should be called from the actual application pathways 
 * (e.g. webhooks, api auth checks, AI calls).
 * 
 * It's recommended to call this without `await` to avoid blocking the main request path:
 * `recordTelemetry('api_auth', 'up', 'Valid API key', 15).catch(console.error);`
 */
export async function recordTelemetry(
  systemKey: string,
  status: SystemHealthStatus,
  message: string = '',
  latencyMs: number = 0
): Promise<void> {
  // Telemetry is intended to be fast and not fail the main request.
  try {
    const { error } = await supabaseAdmin.from('system_telemetry').insert({
      system_key: systemKey,
      status: status === 'skipped' ? 'up' : status, // 'skipped' mapped to 'up' for telemetry
      message,
      latency_ms: latencyMs,
    });

    if (error) {
      console.warn(`[Telemetry] Failed to record telemetry for ${systemKey}:`, error.message);
    }
  } catch (err) {
    console.warn(`[Telemetry] Exception recording telemetry for ${systemKey}:`, err);
  }
}
