import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { SystemHealthStatus } from './types';
import { claimKey, sha256 } from '@/lib/security/upstash-rest';

const TELEMETRY_TIMEOUT_MS = 3_000;

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
      .abortSignal(AbortSignal.timeout(TELEMETRY_TIMEOUT_MS))
      .maybeSingle();

    if (error) {
      console.error('[Telemetry] Evidence read failed');
      return null;
    }
    if (!data) {
      return null;
    }
    return data as TelemetryRecord;
  } catch (err) {
    console.error('[Telemetry] Evidence read unavailable');
    return null;
  }
}

/**
 * Records passive telemetry for a given system.
 * This should be called from the actual application pathways 
 * (e.g. webhooks, api auth checks, AI calls).
 * 
 * In middleware, register the returned promise with NextFetchEvent.waitUntil().
 * In Route Handlers, use next/server after() or await it before returning.
 * An unregistered background promise may be interrupted after the response.
 */
export async function recordTelemetry(
  systemKey: string,
  status: SystemHealthStatus,
  message: string = '',
  latencyMs: number = 0
): Promise<void> {
  // Telemetry is intended to be fast and not fail the main request.
  if (status === 'skipped') return; // Absence of evidence is never success.
  try {
    if (status === 'up' && systemKey === 'api_auth') {
      const fingerprint = await sha256(`${systemKey}:${status}:${message}`);
      const claim = await claimKey(`telemetry:sample:${fingerprint}`, 60, 'telemetry-sample');
      // Sample repetitive authentication only. Every real business operation
      // and every failure is retained, including rapid failure/recovery cycles.
      // Missing Redis must not silently disable every health receipt.
      if (claim.state === 'contended') return;
    }

    const { error } = await supabaseAdmin.from('system_telemetry').insert({
      system_key: systemKey,
      status,
      message,
      latency_ms: latencyMs,
    }).abortSignal(AbortSignal.timeout(TELEMETRY_TIMEOUT_MS));

    if (error) {
      console.warn('[Telemetry] Evidence write failed');
    }
  } catch (err) {
    console.warn('[Telemetry] Evidence write unavailable');
  }
}
