import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  addMinutes,
  parseISO,
  startOfDay,
  endOfDay,
  isAfter,
  isBefore,
  setHours,
  setMinutes,
  eachDayOfInterval,
  format,
} from 'date-fns';
import { slotOverlapsBreaks } from '@/lib/reservations/weekly-hours';

/** Half-open [start, end): back-to-back slots (10:00-11:00 and 11:00-12:00) do not overlap. */
export function intervalsOverlap(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
  return startA < endB && endA > startB;
}

export async function getBookedSeats(
  catalogItemId: string,
  start: Date,
  end: Date
) {
  const { data: reservations, error } = await supabaseAdmin
    .from('reservations')
    .select('quantity, status')
    .eq('catalog_item_id', catalogItemId)
    .in('status', ['pending', 'confirmed'])
    .gt('end_time', start.toISOString())
    .lt('start_time', end.toISOString());

  if (error) {
    console.error('Error fetching booked seats:', error);
    return 0;
  }

  return (reservations || []).reduce((acc: number, res: any) => acc + (res.quantity || 1), 0);
}

export class ReservableCatalogItemError extends Error {
  readonly statusCode = 400;
  readonly catalog_item_id?: string;
  readonly reservation_id?: string;

  constructor(
    message: string,
    extra?: { catalog_item_id?: string; reservation_id?: string }
  ) {
    super(message);
    this.name = 'ReservableCatalogItemError';
    this.catalog_item_id = extra?.catalog_item_id;
    this.reservation_id = extra?.reservation_id;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type ResolvedReservableCatalogItem = {
  catalog_item_id: string;
  reservation_id?: string;
};

/**
 * catalog_item_id must be a reservable catalog item.
 * A reservation folio is a failed param: the error includes the real catalog_item_id
 * so the completion loop can ask the model to retry.
 */
export async function resolveReservableCatalogItemId(candidateId: string): Promise<ResolvedReservableCatalogItem> {
  const { data: item } = await supabaseAdmin
    .from('catalog_items')
    .select('id, is_reservation')
    .eq('id', candidateId)
    .maybeSingle();

  if (item?.id) {
    if (item.is_reservation === false) {
      throw new ReservableCatalogItemError(
        `catalog_item_id=${candidateId} is not a reservable catalog item`
      );
    }
    return { catalog_item_id: item.id };
  }

  const { data: reservation } = await supabaseAdmin
    .from('reservations')
    .select('id, catalog_item_id')
    .eq('id', candidateId)
    .maybeSingle();

  if (reservation?.catalog_item_id) {
    throw new ReservableCatalogItemError(
      `catalog_item_id is a reservation id; use catalog_item_id=${reservation.catalog_item_id} and pass the reservation as id for update`,
      { catalog_item_id: reservation.catalog_item_id, reservation_id: reservation.id }
    );
  }

  throw new ReservableCatalogItemError(`catalog item not found: ${candidateId}`);
}

export async function getAvailableSlots(
  catalogItemId: string,
  startDateStr: string,
  endDateStr: string,
  qty: number = 1
) {
  const resolved = await resolveReservableCatalogItemId(catalogItemId);
  const resolvedId = resolved.catalog_item_id;

  // 1. Get schedule
  const { data: schedule } = await supabaseAdmin
    .from('reservation_schedules')
    .select('*')
    .eq('catalog_item_id', resolvedId)
    .single();

  if (!schedule) {
    throw new ReservableCatalogItemError(
      `Item is reservable but has no schedule configured (catalog_item_id=${resolvedId})`,
      { catalog_item_id: resolvedId }
    );
  }

  const days = eachDayOfInterval({ start: parseISO(startDateStr), end: parseISO(endDateStr) });
  const result: { start: string; end: string; available: number }[] = [];

  const duration = schedule.duration_minutes || 60;
  const capacity = schedule.capacity || 1;

  // 2. Get reservations
  const rangeStart = startOfDay(parseISO(startDateStr));
  const rangeEnd = endOfDay(parseISO(endDateStr));

  const { data: reservations } = await supabaseAdmin
    .from('reservations')
    .select('start_time, end_time, quantity, status')
    .eq('catalog_item_id', resolvedId)
    .in('status', ['pending', 'confirmed'])
    .lt('start_time', rangeEnd.toISOString())
    .gt('end_time', rangeStart.toISOString());

  // 3. Get calendar blocks
  const { data: calendarBlocks } = await supabaseAdmin
    .from('calendar_blocks')
    .select('start_time, end_time, entity_type, entity_id')
    .eq('site_id', schedule.site_id)
    .in('entity_type', ['global', 'catalog_item'])
    .lte('start_time', rangeEnd.toISOString())
    .gte('end_time', rangeStart.toISOString());

  for (const dateObj of days) {
    const dayOfWeek = format(dateObj, 'eeee').toLowerCase();
    const dayConfig = schedule.days[dayOfWeek];

    if (!dayConfig?.enabled || !dayConfig.start || !dayConfig.end) continue;

    const [startH, startM] = dayConfig.start.split(':').map(Number);
    const [endH, endM] = dayConfig.end.split(':').map(Number);

    const dayStart = setMinutes(setHours(dateObj, startH), startM);
    const dayEnd = setMinutes(setHours(dateObj, endH), endM);

    let current = dayStart;
    while (isBefore(current, dayEnd)) {
      const slotEnd = addMinutes(current, duration);
      if (isAfter(slotEnd, dayEnd)) break;

      const slotStartMin = current.getHours() * 60 + current.getMinutes();
      const slotEndMin = slotEnd.getHours() * 60 + slotEnd.getMinutes() || 24 * 60;
      if (slotOverlapsBreaks(slotStartMin, slotEndMin, dayConfig.breaks)) {
        current = slotEnd;
        continue;
      }

      const booked = (reservations || []).filter((r: any) => {
        return intervalsOverlap(current, slotEnd, new Date(r.start_time), new Date(r.end_time));
      }).reduce((acc: number, r: any) => acc + (r.quantity || 1), 0);

      const isBlocked = (calendarBlocks || []).some((b: any) => {
        const applies = b.entity_type === 'global' || (b.entity_type === 'catalog_item' && b.entity_id === resolvedId);
        if (!applies) return false;
        return intervalsOverlap(current, slotEnd, new Date(b.start_time), new Date(b.end_time));
      });

      const available = isBlocked ? 0 : capacity - booked;

      if (available >= qty && isAfter(current, new Date())) {
        result.push({
          start: current.toISOString(),
          end: slotEnd.toISOString(),
          available
        });
      }
      
      current = slotEnd;
    }
  }

  return {
    slots: result,
    catalog_item_id: resolvedId,
    ...(resolved.reservation_id ? { reservation_id: resolved.reservation_id } : {}),
  };
}

export async function assertReservationSlot(
  siteId: string,
  catalogItemId: string,
  startIso: string,
  endIso: string,
  quantity: number,
  isAdmin: boolean = false
) {
  const { data: schedule } = await supabaseAdmin
    .from('reservation_schedules')
    .select('*')
    .eq('catalog_item_id', catalogItemId)
    .single();

  if (!schedule) {
    throw new Error('Item is reservable but has no schedule configured');
  }

  // Validate siteId matches
  if (schedule.site_id !== siteId) {
    throw new Error('Reservation schedule does not belong to the specified site');
  }

  const start = parseISO(startIso);
  const end = parseISO(endIso);
  
  if (isBefore(start, new Date()) && !isAdmin) {
    throw new Error('Cannot book in the past');
  }

  const dayOfWeek = format(start, 'eeee').toLowerCase();
  const dayConfig = schedule.days[dayOfWeek];

  if (!dayConfig?.enabled || !dayConfig.start || !dayConfig.end) {
    throw new Error('Slot is outside of available schedule days');
  }

  const [startH, startM] = dayConfig.start.split(':').map(Number);
  const [endH, endM] = dayConfig.end.split(':').map(Number);

  const dayStart = setMinutes(setHours(start, startH), startM);
  const dayEnd = setMinutes(setHours(start, endH), endM);

  if (isBefore(start, dayStart) || isAfter(end, dayEnd)) {
    throw new Error('Slot is outside of available schedule hours');
  }

  const slotStartMin = start.getHours() * 60 + start.getMinutes();
  const slotEndMin = end.getHours() * 60 + end.getMinutes() || 24 * 60;
  if (slotOverlapsBreaks(slotStartMin, slotEndMin, dayConfig.breaks)) {
    throw new Error('Slot overlaps a break (e.g. lunch) in the schedule');
  }

  // Check calendar blocks
  const { data: calendarBlocks } = await supabaseAdmin
    .from('calendar_blocks')
    .select('start_time, end_time, entity_type, entity_id')
    .eq('site_id', siteId)
    .in('entity_type', ['global', 'catalog_item'])
    .lte('start_time', endIso)
    .gte('end_time', startIso);

  const isBlocked = (calendarBlocks || []).some((b: any) => {
    const applies = b.entity_type === 'global' || (b.entity_type === 'catalog_item' && b.entity_id === catalogItemId);
    if (!applies) return false;

    return intervalsOverlap(start, end, new Date(b.start_time), new Date(b.end_time));
  });

  if (isBlocked) {
    throw new Error('Slot overlaps with a calendar block');
  }

  const capacity = schedule.capacity || 1;
  const booked = await getBookedSeats(catalogItemId, start, end);
  const remaining = capacity - booked;
  if (remaining < quantity) {
    throw new Error(
      `Not enough capacity for this slot (requested ${quantity}, remaining ${remaining}, capacity ${capacity})`
    );
  }

  return true;
}
