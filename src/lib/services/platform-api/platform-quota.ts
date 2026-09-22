import { supabaseAdmin } from '@/lib/database/supabase-client';

/** Default daily quotas per capability. Override per `site_id` via platform_quotas.quota_override. */
const DEFAULT_DAILY_QUOTAS: Record<string, number> = {
  'email.send': 200,
  'whatsapp.send': 100,
  'leads.read': 5000,
  'leads.write': 1000,
  'notifications.create': 2000,
  'tracking.event.write': 50000,
  'agents.invoke': 500,
  'db.migrate': 50,
};

const SOFT_WARN_RATIO = 0.8;

export interface QuotaDecision {
  allowed: boolean;
  used: number;
  limit: number;
  softWarn: boolean;
  reason?: string;
}

function currentPeriodKey(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Checks if a capability call is within quota. Increments usage when `allowed`
 * is true — callers should only consume one token per logical call.
 */
export async function reserveQuota(params: { site_id: string; capability: string; cost?: number }): Promise<QuotaDecision> {
  try {
    const period = currentPeriodKey();
    const cost = Math.max(1, Math.round(params.cost ?? 1));
    const defaultLimit = DEFAULT_DAILY_QUOTAS[params.capability] ?? 1000;
    const { data, error } = await supabaseAdmin.rpc(
      'reserve_platform_quota',
      {
        p_site_id: params.site_id,
        p_capability: params.capability,
        p_period: period,
        p_cost: cost,
        p_default_limit: defaultLimit,
      },
    );
    if (!error && data?.[0]) {
      const result = data[0] as {
        allowed: boolean;
        used: number;
        quota_limit: number;
      };
      return {
        allowed: result.allowed,
        used: result.used,
        limit: result.quota_limit,
        softWarn: result.used >= Math.floor(
          result.quota_limit * SOFT_WARN_RATIO,
        ),
        ...(!result.allowed ? {
          reason: `Daily quota exhausted for capability "${params.capability}" (used=${result.used}, limit=${result.quota_limit}).`,
        } : {}),
      };
    }
    throw new Error(error?.message || 'Atomic quota reservation returned no data');
  } catch (e: unknown) {
    console.error(
      '[PlatformQuota] reservation unavailable:',
      e instanceof Error ? e.message : e,
    );
    return {
      allowed: false,
      used: 0,
      limit: DEFAULT_DAILY_QUOTAS[params.capability] ?? 0,
      softWarn: false,
      reason: 'Quota service is temporarily unavailable.',
    };
  }
}
