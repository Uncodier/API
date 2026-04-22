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

async function loadUsage(params: { site_id: string; capability: string; period: string }): Promise<{ used: number; limit: number; rowId?: string }> {
  const { data } = await supabaseAdmin
    .from('platform_quotas')
    .select('id, used, quota_override')
    .eq('site_id', params.site_id)
    .eq('capability', params.capability)
    .eq('period', params.period)
    .maybeSingle();
  const defaultLimit = DEFAULT_DAILY_QUOTAS[params.capability] ?? 1000;
  return {
    used: (data?.used as number | undefined) ?? 0,
    limit: (data?.quota_override as number | undefined) ?? defaultLimit,
    rowId: (data?.id as string | undefined) ?? undefined,
  };
}

async function incrementUsage(params: { site_id: string; capability: string; period: string; by?: number }): Promise<void> {
  const { data: existing } = await supabaseAdmin
    .from('platform_quotas')
    .select('id, used')
    .eq('site_id', params.site_id)
    .eq('capability', params.capability)
    .eq('period', params.period)
    .maybeSingle();

  const by = params.by ?? 1;
  if (existing?.id) {
    await supabaseAdmin
      .from('platform_quotas')
      .update({ used: (existing.used || 0) + by, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
  } else {
    await supabaseAdmin.from('platform_quotas').insert({
      site_id: params.site_id,
      capability: params.capability,
      period: params.period,
      used: by,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
}

/**
 * Checks if a capability call is within quota. Increments usage when `allowed`
 * is true — callers should only consume one token per logical call.
 */
export async function reserveQuota(params: { site_id: string; capability: string; cost?: number }): Promise<QuotaDecision> {
  try {
    const period = currentPeriodKey();
    const usage = await loadUsage({ site_id: params.site_id, capability: params.capability, period });
    const cost = Math.max(1, Math.round(params.cost ?? 1));
    if (usage.used + cost > usage.limit) {
      return {
        allowed: false,
        used: usage.used,
        limit: usage.limit,
        softWarn: false,
        reason: `Daily quota exhausted for capability "${params.capability}" (used=${usage.used}, limit=${usage.limit}).`,
      };
    }
    await incrementUsage({ site_id: params.site_id, capability: params.capability, period, by: cost });
    const nextUsed = usage.used + cost;
    return {
      allowed: true,
      used: nextUsed,
      limit: usage.limit,
      softWarn: nextUsed >= Math.floor(usage.limit * SOFT_WARN_RATIO),
    };
  } catch (e: unknown) {
    console.warn('[PlatformQuota] failed, allowing call by default:', e instanceof Error ? e.message : e);
    return { allowed: true, used: 0, limit: DEFAULT_DAILY_QUOTAS[params.capability] ?? 0, softWarn: false };
  }
}
