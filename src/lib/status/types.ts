import type { SlaWindow } from '@/lib/status/compute-sla';

export type SystemHealthStatus = 'up' | 'degraded' | 'down' | 'skipped';

export type ProbeTrigger = 'github_push' | 'cron_hourly' | 'manual';

export interface ProviderProbeResult {
  configured: boolean;
  liveProbe: boolean;
  latencyMs: number;
  model: string;
  /** Configuration readiness must not be mistaken for successful generation. */
  verification?: 'configuration' | 'inference';
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
  slaSnapshot: Record<string, SlaWindow>;
}

const SECRET_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[^\s,;"']+/gi,
  /(?:api[_-]?key|secret|password|token|authorization)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
  /sk-[a-zA-Z0-9_-]+/g,
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /Following keys are not valid:\s*[^\s"]+/gi,
];

export function isAiProbeEnabled(): boolean {
  // Billable inference is always explicit, including CI and production.
  return process.env.STATUS_AI_PROBE_ENABLED === 'true';
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
      degradedReasons.push(`${key}_${probe.verification === 'configuration' ? 'generation_unverified' : 'live_probe_failed'}`);
    }
  }

  const primaryConfigured = primaryKeys.filter((k) => providers[k]?.configured && !providers[k]?.skipped);
  const primaryFailed = primaryConfigured.filter((k) => !providers[k]?.liveProbe && providers[k]?.verification !== 'configuration');

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
    let s: string = value;
    // Redact configured credentials before truncation, including unlabelled provider errors.
    for (const [name, secret] of Object.entries(process.env)) {
      if (/(?:api_?key|secret|password|token|credential)$/i.test(name) && secret && secret.length >= 8) {
        s = s.split(secret).join('[redacted]');
      }
    }
    s = s.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        for (const key of Array.from(url.searchParams.keys())) {
          if (/key|secret|password|token|authorization|signature/i.test(key)) {
            url.searchParams.set(key, '[redacted]');
          }
        }
        return url.toString();
      } catch { return '[redacted-url]'; }
    });
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
      if (k !== 'systemKey' && /key|secret|token|password|authorization/i.test(k) && typeof v === 'string') {
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
