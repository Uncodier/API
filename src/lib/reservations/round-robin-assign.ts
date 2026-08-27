import { isItemBookable, isRowBookable } from '@/lib/helpers/catalog-bookable';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  countBookedSeats,
  listFreePeers,
  loadOccupancyContext,
  resolveReservationFamily,
  type OccupancyContext,
  type PeerFamily,
  type ReservationFamily,
} from '@/lib/reservations/family-occupancy';

class RoundRobinAssignError extends Error {
  readonly statusCode = 400;
  readonly name = 'ReservableCatalogItemError';
}

export type RoundRobinRole = 'named' | 'round_robin_parent' | 'round_robin_sibling';

export type RoundRobinAssignment = {
  catalog_item_id: string;
  assigned_from: string;
  peer_root_id: string | null;
  role: RoundRobinRole;
};

type CatalogAssignRow = {
  id: string;
  name?: string | null;
  parent_id?: string | null;
  site_id?: string | null;
  digital_subtype?: string | null;
  status?: string | null;
  availability_status?: string | null;
};

const DEFAULT_PARENT_SERVICE = 'corte';

export function classifyRoundRobinRole(family: ReservationFamily): RoundRobinRole {
  if (family.mode !== 'round_robin') return 'named';
  return family.catalogItemId === family.rootId ? 'round_robin_parent' : 'round_robin_sibling';
}

function normalizeName(value?: string | null): string {
  return String(value || '').trim().toLowerCase();
}

function utcDayBounds(start: Date): { startIso: string; endIso: string } {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  return {
    startIso: new Date(Date.UTC(year, month, day)).toISOString(),
    endIso: new Date(Date.UTC(year, month, day + 1)).toISOString(),
  };
}

async function loadCatalogRow(catalogItemId: string): Promise<CatalogAssignRow> {
  const { data, error } = await supabaseAdmin
    .from('catalog_items')
    .select('id, name, parent_id, site_id, digital_subtype, status, availability_status')
    .eq('id', catalogItemId)
    .maybeSingle();

  if (error || !data?.id) {
    throw new RoundRobinAssignError(`catalog item not found: ${catalogItemId}`);
  }
  return data as CatalogAssignRow;
}

async function loadPassRedeemableRootIds(siteId: string, passCatalogItemId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('pass_redeemable_items')
    .select('reservable_catalog_item_id')
    .eq('site_id', siteId)
    .eq('pass_catalog_item_id', passCatalogItemId);

  if (error) throw new Error(error.message);
  return (data || [])
    .map((row: { reservable_catalog_item_id?: string }) => row.reservable_catalog_item_id)
    .filter((id): id is string => Boolean(id));
}

async function loadPeerCatalogRows(peerIds: string[]): Promise<CatalogAssignRow[]> {
  if (peerIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from('catalog_items')
    .select('id, name, parent_id, site_id, digital_subtype, status, availability_status')
    .in('id', peerIds);

  if (error) throw new Error(error.message);
  return (data || []) as CatalogAssignRow[];
}

async function loadScheduleIds(catalogItemIds: string[]): Promise<Set<string>> {
  if (catalogItemIds.length === 0) return new Set();
  const { data, error } = await supabaseAdmin
    .from('reservation_schedules')
    .select('catalog_item_id')
    .in('catalog_item_id', catalogItemIds);

  if (error) throw new Error(error.message);
  return new Set(
    (data || [])
      .map((row: { catalog_item_id?: string }) => row.catalog_item_id)
      .filter((id): id is string => Boolean(id))
  );
}

async function countPeerBookingsOnDay(familyIds: string[], start: Date): Promise<number> {
  if (familyIds.length === 0) return 0;
  const { startIso, endIso } = utcDayBounds(start);
  const { data, error } = await supabaseAdmin
    .from('reservations')
    .select('id')
    .in('catalog_item_id', familyIds)
    .in('status', ['pending', 'confirmed'])
    .gte('start_time', startIso)
    .lt('start_time', endIso);

  if (error) {
    console.error('Error counting peer day bookings:', error);
    return 0;
  }
  return (data || []).length;
}

function isPeerRootBookable(peer: PeerFamily, byId: Map<string, CatalogAssignRow>): boolean {
  const root = byId.get(peer.rootId);
  if (!root) return false;
  return isRowBookable(root.status, root.availability_status);
}

function matchPeerService(
  peer: PeerFamily,
  byId: Map<string, CatalogAssignRow>,
  serviceName: string | null,
  scheduleIds: Set<string>
): string {
  const children = peer.familyIds
    .map((id) => byId.get(id))
    .filter((row): row is CatalogAssignRow => Boolean(row?.parent_id === peer.rootId))
    .filter((row) => isItemBookable({ ...row, parent: byId.get(peer.rootId) || null }));

  const wanted = normalizeName(serviceName);
  if (wanted) {
    const match = children.find((row) => normalizeName(row.name) === wanted);
    if (match) {
      if (scheduleIds.has(match.id) || !scheduleIds.has(peer.rootId)) return match.id;
      return peer.rootId;
    }
  }

  if (scheduleIds.has(peer.rootId) || children.length === 0) return peer.rootId;
  const scheduledChild = children.find((row) => scheduleIds.has(row.id));
  return scheduledChild?.id || children[0].id;
}

async function pickFreePeer(
  occupancy: OccupancyContext,
  start: Date,
  end: Date,
  quantity: number,
  allowedRootIds: string[] | null,
  byId: Map<string, CatalogAssignRow>
): Promise<PeerFamily> {
  const free = listFreePeers(
    occupancy.peers,
    occupancy.peerReservations,
    occupancy.calendarBlocks,
    start,
    end
  );
  const anonymous = countBookedSeats(
    occupancy.reservations,
    start,
    end,
    occupancy.family.familyIds
  );
  if (free.length - anonymous < quantity) {
    throw new RoundRobinAssignError(
      `Not enough capacity for this slot (requested ${quantity}, remaining ${Math.max(0, free.length - anonymous)})`
    );
  }

  let candidates = free.filter((peer) => isPeerRootBookable(peer, byId));
  if (allowedRootIds && allowedRootIds.length > 0) {
    const allowed = new Set(allowedRootIds);
    candidates = candidates.filter((peer) => allowed.has(peer.rootId));
  }
  if (candidates.length < quantity) {
    throw new RoundRobinAssignError(
      `Not enough capacity for this slot (requested ${quantity}, remaining ${candidates.length})`
    );
  }

  const scored = await Promise.all(
    candidates.map(async (peer) => {
      const bookings = await countPeerBookingsOnDay(peer.familyIds, start);
      const name = normalizeName(byId.get(peer.rootId)?.name);
      return { peer, bookings, name };
    })
  );
  scored.sort((a, b) => a.bookings - b.bookings || a.name.localeCompare(b.name) || a.peer.rootId.localeCompare(b.peer.rootId));
  return scored[0].peer;
}

export async function resolveRoundRobinCatalogItem(params: {
  catalogItemId: string;
  start: string | Date;
  end: string | Date;
  quantity?: number;
  excludeReservationId?: string;
}): Promise<RoundRobinAssignment> {
  const catalogItemId = params.catalogItemId;
  const quantity = params.quantity ?? 1;
  const start = params.start instanceof Date ? params.start : new Date(params.start);
  const end = params.end instanceof Date ? params.end : new Date(params.end);
  const family = await resolveReservationFamily(catalogItemId);
  const role = classifyRoundRobinRole(family);

  if (role === 'named') {
    return {
      catalog_item_id: catalogItemId,
      assigned_from: catalogItemId,
      peer_root_id: family.rootId,
      role,
    };
  }

  const occupancy = await loadOccupancyContext(
    family,
    start.toISOString(),
    end.toISOString(),
    params.excludeReservationId
  );
  const source = await loadCatalogRow(catalogItemId);
  const root =
    source.id === family.rootId ? source : await loadCatalogRow(family.rootId);
  const peerIds = occupancy.peers.flatMap((peer) => peer.familyIds);
  const peerRows = await loadPeerCatalogRows(peerIds);
  const byId = new Map(peerRows.map((row) => [row.id, row]));
  const allowedRootIds =
    source.digital_subtype === 'pass' || root.digital_subtype === 'pass'
      ? await loadPassRedeemableRootIds(family.siteId, family.rootId)
      : null;

  const peer = await pickFreePeer(occupancy, start, end, quantity, allowedRootIds, byId);
  const serviceName = role === 'round_robin_parent' ? DEFAULT_PARENT_SERVICE : source.name || DEFAULT_PARENT_SERVICE;
  const scheduleIds = await loadScheduleIds([peer.rootId, ...peer.familyIds]);
  const assignedId = matchPeerService(peer, byId, serviceName, scheduleIds);

  return {
    catalog_item_id: assignedId,
    assigned_from: catalogItemId,
    peer_root_id: peer.rootId,
    role,
  };
}

export async function resolveReservationUpdateTarget(params: {
  existingCatalogItemId: string;
  requestedCatalogItemId?: string | null;
  start: string;
  end: string;
  quantity: number;
  excludeReservationId: string;
}): Promise<RoundRobinAssignment> {
  const targetId = params.requestedCatalogItemId || params.existingCatalogItemId;
  const family = await resolveReservationFamily(targetId);
  const role = classifyRoundRobinRole(family);

  if (params.requestedCatalogItemId && role === 'named') {
    return {
      catalog_item_id: params.requestedCatalogItemId,
      assigned_from: params.existingCatalogItemId,
      peer_root_id: family.rootId,
      role,
    };
  }

  if (role === 'named') {
    const existingFamily = await resolveReservationFamily(params.existingCatalogItemId);
    if (classifyRoundRobinRole(existingFamily) === 'named') {
      return {
        catalog_item_id: params.existingCatalogItemId,
        assigned_from: params.existingCatalogItemId,
        peer_root_id: existingFamily.rootId,
        role: 'named',
      };
    }
  }

  return resolveRoundRobinCatalogItem({
    catalogItemId: targetId,
    start: params.start,
    end: params.end,
    quantity: params.quantity,
    excludeReservationId: params.excludeReservationId,
  });
}
