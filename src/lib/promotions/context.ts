import { supabaseAdmin } from '@/lib/database/supabase-client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_PROMOTIONS_LIMIT = 10;

export interface ActivePromotionRow {
  id: string;
  name?: string | null;
  code?: string | null;
  discount_type?: string | null;
  discount_value?: number | string | null;
  applies_to?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  channels?: string[] | null;
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export async function loadActivePromotions(
  siteId: string,
  limit = ACTIVE_PROMOTIONS_LIMIT
): Promise<ActivePromotionRow[]> {
  if (!isUuid(siteId)) return [];

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('promotions')
    .select('id, name, code, discount_type, discount_value, applies_to, starts_at, ends_at, channels')
    .eq('site_id', siteId)
    .eq('status', 'active')
    .or(`starts_at.is.null,starts_at.lte."${now.replace(/"/g, '')}"`)
    .or(`ends_at.is.null,ends_at.gte."${now.replace(/"/g, '')}"`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[PromotionsContext] Failed to load active promotions:', error);
    return [];
  }

  return (data || []) as ActivePromotionRow[];
}

function formatDiscount(row: ActivePromotionRow): string {
  const type = row.discount_type || 'n/a';
  const value = row.discount_value == null ? 'n/a' : String(row.discount_value);
  if (type === 'percent') return `${value}%`;
  if (type === 'fixed') return `${value} fixed`;
  if (type === 'bogo') return `BOGO ${value}`;
  return `${type} ${value}`.trim();
}

export function formatActivePromotionsForContext(rows: ActivePromotionRow[]): string {
  let text = `\n\n=== ACTIVE PROMOTIONS (hint) ===\n`;
  if (!rows.length) {
    text += `No active promotions for this site right now. If the customer asks about discounts, codes, or 2x1, call promotions.list with status="active" before answering.\n`;
    return text;
  }

  text += `Snapshot of current active promotions. Treat as a hint — call promotions.list / promotions.get (status=active) if the customer asks about a discount, promo code, BOGO, or a specific item.\n`;
  for (const row of rows) {
    const code = row.code ? ` code=${row.code}` : '';
    const window = ` window=${row.starts_at || 'open'}→${row.ends_at || 'open'}`;
    const channels = Array.isArray(row.channels) && row.channels.length ? ` channels=${row.channels.join(',')}` : '';
    text += `- id=${row.id} name="${row.name || 'N/A'}"${code} discount=${formatDiscount(row)} applies_to=${row.applies_to || 'all'}${window}${channels}\n`;
  }
  return text;
}

export async function appendActivePromotionsToContext(
  contextMessage: string,
  siteId?: string | null
): Promise<string> {
  if (!siteId || !isUuid(siteId)) return contextMessage;
  try {
    const rows = await loadActivePromotions(siteId);
    return `${contextMessage}${formatActivePromotionsForContext(rows)}`;
  } catch (error) {
    console.error('[PromotionsContext] Failed to append active promotions:', error);
    return contextMessage;
  }
}
