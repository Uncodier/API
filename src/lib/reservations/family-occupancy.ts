import { supabaseAdmin } from '@/lib/database/supabase-client';

export type RedeemAssignmentMode = 'user_choice' | 'round_robin';

export type OccupancyReservation = {
  catalog_item_id?: string;
  start_time: string;
  end_time: string;
  quantity?: number;
  status?: string;
};

export type OccupancyBlock = {
  start_time: string;
  end_time: string;
  entity_type: string;
  entity_id?: string | null;
};

export type ReservationFamily = {
  catalogItemId: string;
  rootId: string;
  familyIds: string[];
  mode: RedeemAssignmentMode;
  siteId: string;
};

export type PeerFamily = {
  rootId: string;
  familyIds: string[];
  capacity: number;
};

export type OccupancyContext = {
  family: ReservationFamily;
  reservations: OccupancyReservation[];
  calendarBlocks: OccupancyBlock[];
  peers: PeerFamily[];
  peerReservations: OccupancyReservation[];
};

type CatalogRow = {
  id: string;
  parent_id?: string | null;
  site_id?: string;
  redeem_assignment_mode?: string | null;
  is_reservation?: boolean;
};

/** Half-open [start, end): back-to-back slots do not overlap. */
export function intervalsOverlap(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
  return startA < endB && endA > startB;
}

function normalizeMode(value?: string | null): RedeemAssignmentMode {
  return value === 'round_robin' ? 'round_robin' : 'user_choice';
}

function uniqueIds(ids: Array<string | null | undefined>): string[] {
  return Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
}

export function countBookedSeats(
  reservations: OccupancyReservation[],
  start: Date,
  end: Date,
  familyIds?: string[]
): number {
  return reservations
    .filter((reservation) => {
      if (familyIds && reservation.catalog_item_id && !familyIds.includes(reservation.catalog_item_id)) {
        return false;
      }
      return intervalsOverlap(start, end, new Date(reservation.start_time), new Date(reservation.end_time));
    })
    .reduce((acc, reservation) => acc + (reservation.quantity || 1), 0);
}

export function slotHasBlock(
  blocks: OccupancyBlock[],
  start: Date,
  end: Date,
  familyIds: string[]
): boolean {
  return blocks.some((block) => {
    const applies =
      block.entity_type === 'global' ||
      (block.entity_type === 'catalog_item' && Boolean(block.entity_id) && familyIds.includes(block.entity_id as string));
    if (!applies) return false;
    return intervalsOverlap(start, end, new Date(block.start_time), new Date(block.end_time));
  });
}

export function listFreePeers(
  peers: PeerFamily[],
  peerReservations: OccupancyReservation[],
  blocks: OccupancyBlock[],
  start: Date,
  end: Date
): PeerFamily[] {
  return peers.filter((peer) => {
    if (slotHasBlock(blocks, start, end, peer.familyIds)) return false;
    return countBookedSeats(peerReservations, start, end, peer.familyIds) < peer.capacity;
  });
}

export function countRoundRobinAvailable(
  peers: PeerFamily[],
  peerReservations: OccupancyReservation[],
  ownFamilyReservations: OccupancyReservation[],
  ownFamilyIds: string[],
  blocks: OccupancyBlock[],
  start: Date,
  end: Date
): number {
  const freePeers = listFreePeers(peers, peerReservations, blocks, start, end).length;
  const anonymous = countBookedSeats(ownFamilyReservations, start, end, ownFamilyIds);
  return Math.max(0, freePeers - anonymous);
}

export function availableSeatsForSlot(
  ctx: OccupancyContext,
  start: Date,
  end: Date,
  itemCapacity: number
): { available: number; isBlocked: boolean } {
  const ownBlocked = slotHasBlock(ctx.calendarBlocks, start, end, ctx.family.familyIds);
  if (ctx.family.mode === 'round_robin') {
    if (ownBlocked) return { available: 0, isBlocked: true };
    const available = countRoundRobinAvailable(
      ctx.peers,
      ctx.peerReservations,
      ctx.reservations,
      ctx.family.familyIds,
      ctx.calendarBlocks,
      start,
      end
    );
    return { available, isBlocked: false };
  }

  if (ownBlocked) return { available: 0, isBlocked: true };
  const booked = countBookedSeats(ctx.reservations, start, end, ctx.family.familyIds);
  return { available: itemCapacity - booked, isBlocked: false };
}

export async function resolveReservationFamily(catalogItemId: string): Promise<ReservationFamily> {
  const { data: item, error } = await supabaseAdmin
    .from('catalog_items')
    .select('id, parent_id, site_id, redeem_assignment_mode')
    .eq('id', catalogItemId)
    .maybeSingle();

  if (error || !item?.id) {
    throw new Error(`catalog item not found: ${catalogItemId}`);
  }

  const row = item as CatalogRow;
  let rootId = row.parent_id || row.id;
  let mode = normalizeMode(row.redeem_assignment_mode);
  let siteId = row.site_id || '';

  if (row.parent_id) {
    const { data: parent } = await supabaseAdmin
      .from('catalog_items')
      .select('id, site_id, redeem_assignment_mode')
      .eq('id', row.parent_id)
      .maybeSingle();
    if (parent?.id) {
      rootId = parent.id;
      mode = normalizeMode(parent.redeem_assignment_mode);
      siteId = parent.site_id || siteId;
    }
  }

  const { data: children } = await supabaseAdmin
    .from('catalog_items')
    .select('id')
    .eq('parent_id', rootId);

  return {
    catalogItemId,
    rootId,
    familyIds: uniqueIds([rootId, row.id, ...((children || []) as CatalogRow[]).map((child) => child.id)]),
    mode,
    siteId,
  };
}

export async function loadFamilyReservations(
  familyIds: string[],
  startIso: string,
  endIso: string,
  excludeReservationId?: string
): Promise<OccupancyReservation[]> {
  let query = supabaseAdmin
    .from('reservations')
    .select('catalog_item_id, start_time, end_time, quantity, status')
    .in('catalog_item_id', familyIds)
    .in('status', ['pending', 'confirmed'])
    .lt('start_time', endIso)
    .gt('end_time', startIso);

  if (excludeReservationId) {
    query = query.neq('id', excludeReservationId);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Error fetching family reservations:', error);
    return [];
  }
  return (data || []) as OccupancyReservation[];
}

async function loadCalendarBlocks(siteId: string, startIso: string, endIso: string): Promise<OccupancyBlock[]> {
  const { data, error } = await supabaseAdmin
    .from('calendar_blocks')
    .select('start_time, end_time, entity_type, entity_id')
    .eq('site_id', siteId)
    .in('entity_type', ['global', 'catalog_item'])
    .lte('start_time', endIso)
    .gte('end_time', startIso);

  if (error) {
    console.error('Error fetching calendar blocks:', error);
    return [];
  }
  return (data || []) as OccupancyBlock[];
}

export async function loadOccupancyContext(
  family: ReservationFamily,
  startIso: string,
  endIso: string,
  excludeReservationId?: string
): Promise<OccupancyContext> {
  const reservations = await loadFamilyReservations(
    family.familyIds,
    startIso,
    endIso,
    excludeReservationId
  );
  const calendarBlocks = family.siteId ? await loadCalendarBlocks(family.siteId, startIso, endIso) : [];

  if (family.mode !== 'round_robin') {
    return { family, reservations, calendarBlocks, peers: [], peerReservations: [] };
  }

  const { data: siteItems } = await supabaseAdmin
    .from('catalog_items')
    .select('id, parent_id, redeem_assignment_mode, is_reservation')
    .eq('site_id', family.siteId)
    .eq('is_reservation', true);

  const rows = (siteItems || []) as CatalogRow[];
  const peerRoots = rows.filter(
    (row) => !row.parent_id && normalizeMode(row.redeem_assignment_mode) === 'user_choice'
  );
  const peers: PeerFamily[] = peerRoots.map((root) => ({
    rootId: root.id,
    familyIds: uniqueIds([
      root.id,
      ...rows.filter((row) => row.parent_id === root.id).map((row) => row.id),
    ]),
    capacity: 1,
  }));

  const peerRootIds = peers.map((peer) => peer.rootId);
  if (peerRootIds.length > 0) {
    const { data: schedules } = await supabaseAdmin
      .from('reservation_schedules')
      .select('catalog_item_id, capacity')
      .in('catalog_item_id', peerRootIds);
    const capacityByRoot = new Map(
      ((schedules || []) as Array<{ catalog_item_id: string; capacity?: number }>).map((schedule) => [
        schedule.catalog_item_id,
        schedule.capacity || 1,
      ])
    );
    for (const peer of peers) {
      peer.capacity = capacityByRoot.get(peer.rootId) || 1;
    }
  }

  const peerIds = uniqueIds(peers.flatMap((peer) => peer.familyIds));
  const peerReservations = peerIds.length > 0
    ? await loadFamilyReservations(peerIds, startIso, endIso, excludeReservationId)
    : [];

  return { family, reservations, calendarBlocks, peers, peerReservations };
}
