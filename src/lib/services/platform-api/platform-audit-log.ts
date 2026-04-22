import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface PlatformAuditEntry {
  site_id: string;
  requirement_id?: string | null;
  api_key_id?: string | null;
  endpoint: string;
  method: string;
  status: number;
  scope?: string | null;
  capability?: string | null;
  cost_units?: number;
  latency_ms?: number;
  test_only?: boolean;
  error?: string | null;
  request_summary?: Record<string, any>;
  response_summary?: Record<string, any>;
}

/**
 * Records a single Platform API call. Never throws — audit is best-effort so
 * a failing log does not block real traffic. Schema comes from
 * `create_platform_api_tables.sql`.
 */
export async function logPlatformCall(entry: PlatformAuditEntry): Promise<void> {
  try {
    const payload = {
      site_id: entry.site_id,
      requirement_id: entry.requirement_id ?? null,
      api_key_id: entry.api_key_id ?? null,
      endpoint: entry.endpoint.slice(0, 200),
      method: entry.method.slice(0, 10),
      status: entry.status,
      scope: entry.scope ?? null,
      capability: entry.capability ?? null,
      cost_units: entry.cost_units ?? 1,
      latency_ms: Math.max(0, Math.round(entry.latency_ms ?? 0)),
      test_only: !!entry.test_only,
      error: entry.error ? entry.error.slice(0, 800) : null,
      request_summary: entry.request_summary ?? null,
      response_summary: entry.response_summary ?? null,
      created_at: new Date().toISOString(),
    };
    await supabaseAdmin.from('platform_audit_log').insert(payload);
  } catch (e: unknown) {
    console.warn('[PlatformAudit] failed to log:', e instanceof Error ? e.message : e);
  }
}
