import { supabaseAdmin } from '@/lib/database/supabase-client';

const FALLBACK_CURRENCY = 'USD';

export function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return code || null;
}

/** Catalog item currency first, then site settings, then USD. */
export function resolveLineCurrency(
  itemCurrency: unknown,
  siteCurrency: string = FALLBACK_CURRENCY
): string {
  return normalizeCurrency(itemCurrency) || normalizeCurrency(siteCurrency) || FALLBACK_CURRENCY;
}

export async function resolveSiteCurrency(siteId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('settings')
    .select('currency')
    .eq('site_id', siteId)
    .maybeSingle();

  if (error) {
    console.warn(`[commerce] failed to load site currency for ${siteId}: ${error.message}`);
  }

  return normalizeCurrency(data?.currency) || FALLBACK_CURRENCY;
}
