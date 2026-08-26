import { supabaseAdmin } from '@/lib/database/supabase-client';
import { assertReservationSlot } from '@/lib/reservations/availability';

export type CheckoutModifierLine = {
  catalogItemId: string;
  quantity?: number;
  unitPriceOverride?: number;
};

export type CheckoutLine = {
  catalogItemId: string;
  quantity?: number;
  unitPriceOverride?: number;
  reservationStart?: string;
  reservationEnd?: string;
  modifiers?: CheckoutModifierLine[];
};

export type ProcessedModifier = {
  site_id: string;
  catalog_item_id: string;
  name: string;
  description?: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
  currency: string;
};

export type ProcessedHostLine = {
  site_id: string;
  catalog_item_id: string;
  name: string;
  description?: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
  currency: string;
  reservationStart?: string;
  reservationEnd?: string;
  modifiers: ProcessedModifier[];
};

async function resolveCatalogItem(catalogItemId: string, siteId: string) {
  const { data: catItem, error: catErr } = await supabaseAdmin
    .from('catalog_items')
    .select('id, name, description, target_sale_price, site_id, is_reservation, currency')
    .eq('id', catalogItemId)
    .single();

  if (catErr || !catItem) {
    throw new Error(`Catalog item not found: ${catalogItemId}`);
  }
  if (catItem.site_id !== siteId) {
    throw new Error(`Catalog item ${catalogItemId} does not belong to site ${siteId}`);
  }
  return catItem;
}

/** Soft check: when the host has attached groups, warn-level validation via thrown error only if option is clearly invalid is skipped — allow POS flexibility when no attachments. */
async function softValidateModifierAgainstHost(
  siteId: string,
  hostCatalogItemId: string,
  modifierCatalogItemId: string
) {
  const { data: attachments } = await supabaseAdmin
    .from('catalog_item_modifier_groups')
    .select('modifier_group_id')
    .eq('site_id', siteId)
    .eq('catalog_item_id', hostCatalogItemId);

  if (!attachments?.length) return;

  const groupIds = attachments.map((a) => a.modifier_group_id);
  const { data: options } = await supabaseAdmin
    .from('modifier_group_items')
    .select('catalog_item_id')
    .eq('site_id', siteId)
    .in('modifier_group_id', groupIds)
    .eq('catalog_item_id', modifierCatalogItemId)
    .maybeSingle();

  if (!options) {
    throw new Error(
      `Modifier ${modifierCatalogItemId} is not an option in any modifier group attached to host ${hostCatalogItemId}`
    );
  }
}

export async function processCheckoutLines(params: {
  siteId: string;
  lines: CheckoutLine[];
  finalLeadId: string | null;
}): Promise<{ processedLines: ProcessedHostLine[]; subtotal: number }> {
  const { siteId, lines, finalLeadId } = params;
  let subtotal = 0;
  const processedLines: ProcessedHostLine[] = [];

  for (const line of lines) {
    if (!line?.catalogItemId) throw new Error('Each line requires catalogItemId');
    const quantity = Number(line.quantity || 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Invalid quantity for catalogItemId=${line.catalogItemId}`);
    }

    const catItem = await resolveCatalogItem(line.catalogItemId, siteId);

    if (catItem.is_reservation) {
      if (!line.reservationStart || !line.reservationEnd) {
        throw new Error(
          `Item ${line.catalogItemId} is a reservation. reservationStart and reservationEnd are required.`
        );
      }
      if (!finalLeadId) {
        throw new Error('lead_id or customer_email is required for reservable items');
      }
      const slot = await assertReservationSlot(
        siteId,
        line.catalogItemId,
        line.reservationStart,
        line.reservationEnd,
        quantity,
        true
      );
      line.reservationStart = slot.start_utc;
      line.reservationEnd = slot.end_utc;
    }

    const unitPrice =
      line.unitPriceOverride !== undefined
        ? Number(line.unitPriceOverride)
        : Number(catItem.target_sale_price || 0);
    const lineSubtotal = unitPrice * quantity;
    subtotal += lineSubtotal;

    const modifiers: ProcessedModifier[] = [];
    for (const mod of line.modifiers || []) {
      if (!mod?.catalogItemId) throw new Error('Each modifier requires catalogItemId');
      const modQty = Number(mod.quantity || 1);
      if (!Number.isFinite(modQty) || modQty <= 0) {
        throw new Error(`Invalid quantity for modifier catalogItemId=${mod.catalogItemId}`);
      }

      await softValidateModifierAgainstHost(siteId, line.catalogItemId, mod.catalogItemId);
      const modItem = await resolveCatalogItem(mod.catalogItemId, siteId);
      const modUnit =
        mod.unitPriceOverride !== undefined
          ? Number(mod.unitPriceOverride)
          : Number(modItem.target_sale_price || 0);
      const modSubtotal = modUnit * modQty;
      subtotal += modSubtotal;

      modifiers.push({
        site_id: siteId,
        catalog_item_id: mod.catalogItemId,
        name: modItem.name,
        description: modItem.description,
        quantity: modQty,
        unit_price: modUnit,
        subtotal: modSubtotal,
        currency: modItem.currency || 'USD',
      });
    }

    processedLines.push({
      site_id: siteId,
      catalog_item_id: line.catalogItemId,
      name: catItem.name,
      description: catItem.description,
      quantity,
      unit_price: unitPrice,
      subtotal: lineSubtotal,
      currency: catItem.currency || 'USD',
      reservationStart: line.reservationStart,
      reservationEnd: line.reservationEnd,
      modifiers,
    });
  }

  return { processedLines, subtotal };
}

export function buildOrderItemsJson(processedLines: ProcessedHostLine[]) {
  return processedLines.map((pl) => ({
    id: pl.catalog_item_id,
    name: pl.name,
    quantity: pl.quantity,
    unitPrice: pl.unit_price,
    subtotal: pl.subtotal,
    modifiers: pl.modifiers.map((m) => ({
      id: m.catalog_item_id,
      name: m.name,
      quantity: m.quantity,
      unitPrice: m.unit_price,
      subtotal: m.subtotal,
    })),
  }));
}

export async function insertOrderItemsWithModifiers(
  orderId: string,
  processedLines: ProcessedHostLine[]
) {
  const insertedHosts: Array<{ id: string; catalog_item_id: string }> = [];

  for (const pl of processedLines) {
    const { data: host, error: hostErr } = await supabaseAdmin
      .from('sale_order_items')
      .insert({
        site_id: pl.site_id,
        catalog_item_id: pl.catalog_item_id,
        name: pl.name,
        description: pl.description,
        quantity: pl.quantity,
        unit_price: pl.unit_price,
        subtotal: pl.subtotal,
        sale_order_id: orderId,
        parent_sale_order_item_id: null,
      })
      .select('id, catalog_item_id')
      .single();

    if (hostErr || !host) {
      throw new Error(`Order items creation failed: ${hostErr?.message || 'unknown'}`);
    }
    insertedHosts.push(host);

    if (pl.modifiers.length > 0) {
      const children = pl.modifiers.map((m) => ({
        site_id: m.site_id,
        catalog_item_id: m.catalog_item_id,
        name: m.name,
        description: m.description,
        quantity: m.quantity,
        unit_price: m.unit_price,
        subtotal: m.subtotal,
        sale_order_id: orderId,
        parent_sale_order_item_id: host.id,
      }));

      const { error: childErr } = await supabaseAdmin.from('sale_order_items').insert(children);
      if (childErr) throw new Error(`Order modifier items creation failed: ${childErr.message}`);
    }
  }

  return insertedHosts;
}
