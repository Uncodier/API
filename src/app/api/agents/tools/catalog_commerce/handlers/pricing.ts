import { calculateCatalogLineTax, loadActiveCatalogTaxes, roundMoney } from '../../checkout/taxes';

/** Enrich only after the catalog allowlist, so derived prices are never DB columns. */
export async function withCatalogPricing(siteId: string, items: Record<string, any>[]) {
  if (!items.length) return [];
  if (items.some(item => item.site_id !== siteId || typeof item.id !== 'string')) {
    throw new Error('Catalog pricing site mismatch');
  }
  const taxes = await loadActiveCatalogTaxes(siteId, items.map(item => item.id));
  return items.map(item => {
    const activeTaxes = taxes.get(item.id) || [];
    const raw = item.target_sale_price;
    const base = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
    const available = Number.isFinite(base) && base >= 0 && typeof item.currency === 'string' && !!item.currency.trim();
    const taxAmount = available ? calculateCatalogLineTax(base, activeTaxes) : null;
    return { ...item, pricing: {
      status: available ? 'available' : 'unavailable',
      currency: item.currency || null,
      base_price: available ? base : null,
      base_price_includes_tax: false,
      active_taxes: activeTaxes,
      unit_tax_amount: taxAmount,
      unit_price_with_tax: available ? roundMoney(roundMoney(base) + taxAmount!) : null,
      scope: 'one_unit_before_promotions_shipping_and_modifiers',
    } };
  });
}