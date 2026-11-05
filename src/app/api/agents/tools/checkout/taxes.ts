import { supabaseAdmin } from '@/lib/database/supabase-client';

export function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export type ActiveCatalogTax = { id: string; name: string | null; rate: number };

/** Shared by catalog price previews and checkout; never assume zero on a failed read. */
export async function loadActiveCatalogTaxes(siteId: string, itemIds: string[]) {
  const ids = [...new Set(itemIds)];
  const taxes = new Map<string, ActiveCatalogTax[]>();
  for (let start = 0; start < ids.length; start += 100) {
    const chunk = ids.slice(start, start + 100);
    // Page associations as an item may have more than one tax. Fail closed on errors.
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await supabaseAdmin.from('catalog_item_taxes')
        .select('id, catalog_item_id, tax:taxes(id, name, site_id, rate, is_active)')
        .eq('site_id', siteId).in('catalog_item_id', chunk).order('id').range(offset, offset + 99);
      if (error || !data) throw new Error('Unable to verify checkout taxes');
      for (const row of data) {
        const tax = Array.isArray(row.tax) ? row.tax[0] : row.tax;
        if (!tax || tax.site_id !== siteId || !chunk.includes(row.catalog_item_id)) {
          throw new Error('Invalid checkout tax association');
        }
        if (tax.is_active === false) continue;
        const rate = Number(tax.rate);
        if (tax.rate == null || !Number.isFinite(rate) || rate < 0 || rate > 100) {
          throw new Error('Invalid checkout tax rate');
        }
        const attached = taxes.get(row.catalog_item_id) || [];
        attached.push({ id: tax.id, name: typeof tax.name === 'string' ? tax.name.slice(0, 120) : null, rate });
        taxes.set(row.catalog_item_id, attached);
      }
      if (data.length < 100) break;
    }
  }
  return taxes;
}

export function calculateCatalogLineTax(subtotal: number, taxes: ActiveCatalogTax[]): number {
  return roundMoney(subtotal * taxes.reduce((sum, tax) => sum + tax.rate, 0) / 100);
}

/** Same exclusive, additive, per-line rounding as market-fit/app/commerce/taxes.ts. */
export async function calculateCheckoutTaxTotal(siteId: string, lines: {
  catalog_item_id: string; subtotal: number;
}[]): Promise<number> {
  const taxes = await loadActiveCatalogTaxes(siteId, lines.map(line => line.catalog_item_id));
  return roundMoney(lines.reduce((total, line) => {
    if (!Number.isFinite(line.subtotal) || line.subtotal < 0) throw new Error('Invalid taxable subtotal');
    return total + calculateCatalogLineTax(line.subtotal, taxes.get(line.catalog_item_id) || []);
  }, 0));
}