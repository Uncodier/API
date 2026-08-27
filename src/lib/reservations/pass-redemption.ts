import { supabaseAdmin } from '@/lib/database/supabase-client';

export async function catalogItemCoveredByPass(
  siteId: string,
  passCatalogItemId: string,
  reservableCatalogItemId: string
): Promise<boolean> {
  const { data: item, error: itemErr } = await supabaseAdmin
    .from('catalog_items')
    .select('id, parent_id')
    .eq('id', reservableCatalogItemId)
    .maybeSingle();

  if (itemErr) throw new Error(itemErr.message);
  if (!item?.id) return false;

  const familyIds = [item.id, item.parent_id].filter((id): id is string => Boolean(id));
  const { data, error } = await supabaseAdmin
    .from('pass_redeemable_items')
    .select('id, reservable_catalog_item_id')
    .eq('site_id', siteId)
    .eq('pass_catalog_item_id', passCatalogItemId)
    .in('reservable_catalog_item_id', familyIds);

  if (error) throw new Error(error.message);
  return (data || []).length > 0;
}

async function loadLeadBuyerUserId(leadId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('leads')
    .select('user_id')
    .eq('id', leadId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data?.user_id || null;
}

export async function resolveReservationEntitlement(params: {
  siteId: string;
  leadId: string;
  quantity: number;
  catalogItemId: string;
  originalCatalogItemId: string;
  requestedEntitlementId?: string | null;
}): Promise<string | null> {
  const requested = params.requestedEntitlementId || null;

  if (requested) {
    const { data: ent, error } = await supabaseAdmin
      .from('entitlements')
      .select('id, status, uses_remaining, catalog_item_id')
      .eq('id', requested)
      .eq('site_id', params.siteId)
      .single();

    if (error || !ent) throw new Error(`Entitlement not found: ${requested}`);
    if (ent.status !== 'active') throw new Error(`Entitlement ${requested} is not active`);
    if (ent.uses_remaining !== null && ent.uses_remaining < params.quantity) {
      throw new Error(`Entitlement ${requested} does not have enough uses remaining`);
    }

    const covered = await catalogItemCoveredByPass(params.siteId, ent.catalog_item_id, params.catalogItemId);
    if (!covered) {
      throw new Error(
        `Catalog item ${params.catalogItemId} is not redeemable with pass ${ent.catalog_item_id}`
      );
    }
    return ent.id;
  }

  const buyerUserId = await loadLeadBuyerUserId(params.leadId);
  if (!buyerUserId) return null;

  let query = supabaseAdmin
    .from('entitlements')
    .select('id, status, uses_remaining, catalog_item_id')
    .eq('site_id', params.siteId)
    .eq('buyer_user_id', buyerUserId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  const { data: original } = await supabaseAdmin
    .from('catalog_items')
    .select('id, digital_subtype')
    .eq('id', params.originalCatalogItemId)
    .maybeSingle();

  if (original?.digital_subtype === 'pass') {
    query = query.eq('catalog_item_id', original.id);
  }

  const { data: entitlements, error } = await query;
  if (error) throw new Error(error.message);

  for (const ent of entitlements || []) {
    if (ent.uses_remaining !== null && ent.uses_remaining < params.quantity) continue;
    const covered = await catalogItemCoveredByPass(params.siteId, ent.catalog_item_id, params.catalogItemId);
    if (covered) return ent.id;
  }

  return null;
}
