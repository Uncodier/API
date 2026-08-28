import { supabaseAdmin } from '@/lib/database/supabase-client';

export interface DiscountLineItem {
  id: string;
  quantity: number;
  subtotal: number;
}

export interface AppliedPromotion {
  id: string;
  name: string;
  discount_amount: number;
  code?: string | null;
}

export interface DiscountResult {
  discountAmount: number;
  appliedPromotions: AppliedPromotion[];
}

export interface PromotionCandidate {
  id: string;
  name?: string | null;
  code?: string | null;
  discount_type?: string | null;
  discount_value?: number | string | null;
  applies_to?: string | null;
  min_order_amount?: number | string | null;
  promotion_catalog_items?: Array<{ catalog_item_id?: string | null }> | null;
  promotion_catalog_categories?: Array<{ catalog_category_id?: string | null }> | null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function moneyLabel(amount: number, currency?: string | null): string {
  const code = (currency || '').trim().toUpperCase();
  return code ? `${code} ${amount}` : String(amount);
}

export function formatAppliedPromotionsNotification(
  appliedPromotions: AppliedPromotion[],
  subtotal: number,
  discountAmount: number,
  amountDue: number,
  currency?: string | null
): string | undefined {
  if (!appliedPromotions.length || discountAmount <= 0) return undefined;
  const names = appliedPromotions.map((p) => p.name).join(', ');
  return (
    `Automatically applied ${appliedPromotions.length} compatible promotion(s): ${names}. ` +
    `Subtotal ${moneyLabel(subtotal, currency)}, discount ${moneyLabel(discountAmount, currency)}, ` +
    `amount due ${moneyLabel(amountDue, currency)}. Tell the customer this discounted total.`
  );
}

function applicableLinesForPromo(
  promo: PromotionCandidate,
  lines: DiscountLineItem[],
  itemCategoryMap: Map<string, string>
): DiscountLineItem[] {
  const appliesTo = promo.applies_to || 'all';
  if (appliesTo !== 'selected_items') return [...lines];

  const allowedItemIds = new Set(
    (promo.promotion_catalog_items || []).map((row) => row.catalog_item_id).filter(Boolean) as string[]
  );
  const allowedCategoryIds = new Set(
    (promo.promotion_catalog_categories || [])
      .map((row) => row.catalog_category_id)
      .filter(Boolean) as string[]
  );

  return lines.filter((line) => {
    if (allowedItemIds.has(line.id)) return true;
    const categoryId = itemCategoryMap.get(line.id);
    return Boolean(categoryId && allowedCategoryIds.has(categoryId));
  });
}

function discountForPromo(promo: PromotionCandidate, applicableSubtotal: number): number {
  const discountType = promo.discount_type;
  const discountValue = Number(promo.discount_value || 0);
  if (!Number.isFinite(discountValue) || discountValue <= 0) return 0;

  if (discountType === 'percent') {
    return applicableSubtotal * (discountValue / 100);
  }
  if (discountType === 'fixed') {
    return Math.min(discountValue, applicableSubtotal);
  }
  return 0;
}

export function evaluateCompatiblePromotions(
  promotions: PromotionCandidate[],
  lines: DiscountLineItem[],
  itemCategoryMap: Map<string, string> = new Map()
): DiscountResult {
  const empty: DiscountResult = { discountAmount: 0, appliedPromotions: [] };
  if (!promotions.length || !lines.length) return empty;

  const cartSubtotal = lines.reduce((sum, line) => sum + Number(line.subtotal || 0), 0);
  let bestPromo: PromotionCandidate | null = null;
  let maxDiscount = 0;

  for (const promo of promotions) {
    const minOrder = Number(promo.min_order_amount);
    if (Number.isFinite(minOrder) && minOrder > 0 && cartSubtotal < minOrder) continue;

    const applicableLines = applicableLinesForPromo(promo, lines, itemCategoryMap);
    if (applicableLines.length === 0) continue;

    const applicableSubtotal = applicableLines.reduce((sum, line) => sum + Number(line.subtotal || 0), 0);
    const promoDiscount = discountForPromo(promo, applicableSubtotal);
    if (promoDiscount > maxDiscount) {
      maxDiscount = promoDiscount;
      bestPromo = promo;
    }
  }

  if (!bestPromo || maxDiscount <= 0) return empty;

  const discountAmount = roundMoney(Math.min(maxDiscount, cartSubtotal));
  return {
    discountAmount,
    appliedPromotions: [
      {
        id: bestPromo.id,
        name: bestPromo.name || 'Promotion',
        discount_amount: discountAmount,
        code: bestPromo.code,
      },
    ],
  };
}

async function loadActivePromotionCandidates(siteId: string): Promise<PromotionCandidate[]> {
  const now = new Date().toISOString();
  let query = supabaseAdmin
    .from('promotions')
    .select(
      `id, name, code, discount_type, discount_value, applies_to, min_order_amount, starts_at, ends_at,
      promotion_catalog_items(catalog_item_id),
      promotion_catalog_categories(catalog_category_id)`
    )
    .eq('site_id', siteId)
    .eq('status', 'active');

  if (typeof (query as { or?: unknown }).or === 'function') {
    query = query
      .or(`starts_at.is.null,starts_at.lte."${now.replace(/"/g, '')}"`)
      .or(`ends_at.is.null,ends_at.gte."${now.replace(/"/g, '')}"`);
  }
  if (typeof (query as { order?: unknown }).order === 'function') {
    query = query.order('created_at', { ascending: false });
  }

  const { data, error } = await query;
  if (error || !Array.isArray(data)) return [];
  return data as PromotionCandidate[];
}

async function loadItemCategoryMap(lineItemIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!lineItemIds.length) return map;
  try {
    const { data } = await supabaseAdmin
      .from('catalog_items')
      .select('id, category_id')
      .in('id', lineItemIds);
    for (const item of data || []) {
      if (item?.id && item?.category_id) map.set(item.id, item.category_id);
    }
  } catch (error) {
    console.error('[PromotionsApply] Failed to load catalog item categories:', error);
  }
  return map;
}

export async function calculateAutoDiscount(
  siteId: string,
  lines: DiscountLineItem[]
): Promise<DiscountResult> {
  const empty: DiscountResult = { discountAmount: 0, appliedPromotions: [] };
  if (!siteId || !lines.length) return empty;

  try {
    const promotions = await loadActivePromotionCandidates(siteId);
    if (!promotions.length) return empty;
    const itemCategoryMap = await loadItemCategoryMap(lines.map((line) => line.id));
    return evaluateCompatiblePromotions(promotions, lines, itemCategoryMap);
  } catch (error) {
    console.error('[PromotionsApply] Failed to calculate auto discount:', error);
    return empty;
  }
}
