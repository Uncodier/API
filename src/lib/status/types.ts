export type SystemHealthStatus = 'up' | 'degraded' | 'down' | 'skipped';

export type ProbeTrigger = 'github_push' | 'cron_hourly' | 'manual';

export interface ProviderProbeResult {
  configured: boolean;
  liveProbe: boolean;
  latencyMs: number;
  model: string;
  skipped?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface SystemHealthResponse {
  systemKey: string;
  label: string;
  status: SystemHealthStatus;
  checkedAt: string;
  latencyMs: number;
  summary: string;
  checks: Record<string, unknown>;
  degradedReasons?: string[];
  error?: { code: string; message: string };
  probePath?: string;
}

export interface SystemHealthHandler {
  systemKey: string;
  label: string;
  probePath?: string;
  runCheck(options?: { useCache?: boolean }): Promise<SystemHealthResponse>;
}

export interface ProbeRunResult {
  runId: string;
  trigger: ProbeTrigger;
  overallStatus: 'healthy' | 'degraded' | 'down';
  durationMs: number;
  systems: SystemHealthResponse[];
  slaSnapshot: Record<string, { uptime24h: number; uptime7d: number; uptime30d: number }>;
}

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /authorization/i,
  /bearer\s+/i,
  /sk-[a-zA-Z0-9]+/,
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /Following keys are not valid:\s*[^\s"]+/gi,
];

export function isAiProbeEnabled(): boolean {
  if (process.env.STATUS_AI_PROBE_ENABLED !== 'false') {
    return true;
  }
  // Allow opt-out locally only; CI and production always probe live
  if (process.env.CI === 'true') return true;
  if (process.env.NODE_ENV === 'production') return true;
  if (process.env.VERCEL === '1') return true;
  return false;
}

export function evaluateAiProviders(
  providers: Record<string, ProviderProbeResult>,
  primaryKeys: string[],
): { status: SystemHealthStatus; degradedReasons: string[] } {
  const degradedReasons: string[] = [];
  const entries = Object.entries(providers);

  const configured = entries.filter(([, p]) => p.configured && !p.skipped);
  if (configured.length === 0 && primaryKeys.length > 0) {
    return { status: 'down', degradedReasons: ['no_providers_configured'] };
  }

  for (const [key, probe] of configured) {
    if (!probe.liveProbe) {
      degradedReasons.push(`${key}_live_probe_failed`);
    }
  }

  const primaryConfigured = primaryKeys.filter((k) => providers[k]?.configured && !providers[k]?.skipped);
  const primaryFailed = primaryConfigured.filter((k) => !providers[k]?.liveProbe);

  if (primaryConfigured.length > 0 && primaryFailed.length === primaryConfigured.length) {
    return { status: 'down', degradedReasons };
  }
  if (degradedReasons.length > 0) {
    return { status: 'degraded', degradedReasons };
  }
  return { status: 'up', degradedReasons: [] };
}

export function buildHealthResponse(
  partial: Omit<SystemHealthResponse, 'checkedAt'> & { checkedAt?: string },
): SystemHealthResponse {
  return {
    ...partial,
    checkedAt: partial.checkedAt ?? new Date().toISOString(),
  };
}

export function sanitizePublicPayload<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    let s = value;
    for (const pattern of SECRET_PATTERNS) {
      s = s.replace(pattern, '[redacted]');
    }
    if (s.length > 200) {
      return s.slice(0, 200) + '…' as T;
    }
    return s as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePublicPayload(item)) as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/key|secret|token|password|authorization/i.test(k) && typeof v === 'string') {
        out[k] = v ? '[set]' : '[unset]';
        continue;
      }
      out[k] = sanitizePublicPayload(v);
    }
    return out as T;
  }
  return value;
}

/** Full production gate (cron + strict CI). */
export const CRITICAL_SYSTEM_KEYS = [
  'database_main',
  'env_core',
  'api_auth',
  'ai_portkey',
  'ai_text',
  'ai_text_continuation',
  'ai_image',
  'ai_video',
  'ai_audio',
] as const;

/** CI deploy check — DB + env only; AI/http need prod secrets & live providers. */
export const CRITICAL_CI_KEYS = ['database_main', 'env_core'] as const;

export function isCriticalFailure(
  system: SystemHealthResponse,
  keys: readonly string[] = CRITICAL_SYSTEM_KEYS,
): boolean {
  if (!keys.includes(system.systemKey)) {
    return false;
  }
  return system.status === 'down' || system.status === 'degraded';
}
