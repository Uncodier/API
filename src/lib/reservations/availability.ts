import { supabaseAdmin } from '@/lib/database/supabase-client';
import { addMinutes, isAfter, isBefore } from 'date-fns';
import { slotOverlapsBreaks } from '@/lib/reservations/weekly-hours';
import {
  availableSeatsForSlot,
  countBookedSeats,
  loadOccupancyContext,
  resolveReservationFamily,
} from '@/lib/reservations/family-occupancy';
import {
  formatInTimezone,
  isLocalDateString,
  localDateBoundsToUtc,
  localWallTimeToUtc,
  localYmd,
  normalizeTimezone,
  parseInstantOrWallClock,
} from '@/lib/timezone';

export { intervalsOverlap } from '@/lib/reservations/family-occupancy';

const WEEKDAY_FROM_UTC_DAY = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export async function getBookedSeats(
  catalogItemId: string,
  start: Date,
  end: Date,
  excludeReservationId?: string
) {
  const family = await resolveReservationFamily(catalogItemId);
  let query = supabaseAdmin
    .from('reservations')
    .select('catalog_item_id, quantity, status, start_time, end_time')
    .in('catalog_item_id', family.familyIds)
    .in('status', ['pending', 'confirmed'])
    .gt('end_time', start.toISOString())
    .lt('start_time', end.toISOString());

  if (excludeReservationId) {
    query = query.neq('id', excludeReservationId);
  }

  const { data: reservations, error } = await query;

  if (error) {
    console.error('Error fetching booked seats:', error);
    return 0;
  }

  return countBookedSeats(reservations || [], start, end, family.familyIds);
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

export type AvailableSlot = {
  start: string;
  end: string;
  start_local: string;
  end_local: string;
  timezone: string;
  available: number;
};

function toLocalYmd(value: string): string {
  const prefix = String(value || '').slice(0, 10);
  if (!isLocalDateString(prefix)) {
    throw new ReservableCatalogItemError('from_date and to_date must be YYYY-MM-DD local calendar dates');
  }
  return prefix;
}

function addCalendarDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function eachYmdInclusive(fromYmd: string, toYmd: string): string[] {
  const start = fromYmd <= toYmd ? fromYmd : toYmd;
  const end = fromYmd <= toYmd ? toYmd : fromYmd;
  const out: string[] = [];
  for (let ymd = start; ymd <= end; ymd = addCalendarDays(ymd, 1)) {
    out.push(ymd);
  }
  return out;
}

function weekdayFromYmd(ymd: string): string {
  const [year, month, day] = ymd.split('-').map(Number);
  return WEEKDAY_FROM_UTC_DAY[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function toClockTime(hhmm: string): string {
  const [hours = '00', minutes = '00'] = hhmm.split(':');
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00`;
}

function wallClockToUtc(ymd: string, timezone: string, hhmm: string): Date {
  return localWallTimeToUtc(ymd, timezone, toClockTime(hhmm));
}

function wallClockMinutes(date: Date, timezone: string): number {
  const [hours, minutes] = formatInTimezone(date, timezone, 'HH:mm').split(':').map(Number);
  return hours * 60 + minutes;
}

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

  const tz = normalizeTimezone(schedule.timezone);
  const fromYmd = toLocalYmd(startDateStr);
  const toYmd = toLocalYmd(endDateStr);
  const range = localDateBoundsToUtc(tz, fromYmd, toYmd);
  const result: AvailableSlot[] = [];

  const duration = schedule.duration_minutes || 60;
  const capacity = schedule.capacity || 1;
  const family = await resolveReservationFamily(resolvedId);
  const occupancy = await loadOccupancyContext(family, range.start_utc, range.end_utc);

  for (const ymd of eachYmdInclusive(range.local_start, range.local_end)) {
    const dayConfig = schedule.days[weekdayFromYmd(ymd)];

    if (!dayConfig?.enabled || !dayConfig.start || !dayConfig.end) continue;

    const dayStart = wallClockToUtc(ymd, tz, dayConfig.start);
    const dayEnd = wallClockToUtc(ymd, tz, dayConfig.end);

    let current = dayStart;
    while (isBefore(current, dayEnd)) {
      const slotEnd = addMinutes(current, duration);
      if (isAfter(slotEnd, dayEnd)) break;

      const slotStartMin = wallClockMinutes(current, tz);
      const slotEndMin = wallClockMinutes(slotEnd, tz) || 24 * 60;
      if (slotOverlapsBreaks(slotStartMin, slotEndMin, dayConfig.breaks)) {
        current = slotEnd;
        continue;
      }

      const { available } = availableSeatsForSlot(occupancy, current, slotEnd, capacity);

      if (available >= qty && isAfter(current, new Date())) {
        result.push({
          start: current.toISOString(),
          end: slotEnd.toISOString(),
          start_local: formatInTimezone(current, tz, 'HH:mm'),
          end_local: formatInTimezone(slotEnd, tz, 'HH:mm'),
          timezone: tz,
          available
        });
      }

      current = slotEnd;
    }
  }

  return {
    slots: result,
    catalog_item_id: resolvedId,
    timezone: tz,
    ...(resolved.reservation_id ? { reservation_id: resolved.reservation_id } : {}),
  };
}

export type AssertedReservationSlot = {
  start_utc: string;
  end_utc: string;
};

export async function assertReservationSlot(
  siteId: string,
  catalogItemId: string,
  startIso: string,
  endIso: string,
  quantity: number,
  isAdmin: boolean = false,
  excludeReservationId?: string
): Promise<AssertedReservationSlot> {
  const { data: schedule } = await supabaseAdmin
    .from('reservation_schedules')
    .select('*')
    .eq('catalog_item_id', catalogItemId)
    .single();

  if (!schedule) {
    throw new Error('Item is reservable but has no schedule configured');
  }

  if (schedule.site_id !== siteId) {
    throw new Error('Reservation schedule does not belong to the specified site');
  }

  const tz = normalizeTimezone(schedule.timezone);
  const start = parseInstantOrWallClock(startIso, tz);
  const end = parseInstantOrWallClock(endIso, tz);

  if (isBefore(start, new Date()) && !isAdmin) {
    throw new Error('Cannot book in the past');
  }

  const ymd = localYmd(start, tz);
  const dayConfig = schedule.days[weekdayFromYmd(ymd)];

  if (!dayConfig?.enabled || !dayConfig.start || !dayConfig.end) {
    throw new Error('Slot is outside of available schedule days');
  }

  const dayStart = wallClockToUtc(ymd, tz, dayConfig.start);
  const dayEnd = wallClockToUtc(ymd, tz, dayConfig.end);

  if (isBefore(start, dayStart) || isAfter(end, dayEnd)) {
    throw new Error('Slot is outside of available schedule hours');
  }

  const slotStartMin = wallClockMinutes(start, tz);
  const slotEndMin = wallClockMinutes(end, tz) || 24 * 60;
  if (slotOverlapsBreaks(slotStartMin, slotEndMin, dayConfig.breaks)) {
    throw new Error('Slot overlaps a break (e.g. lunch) in the schedule');
  }

  const family = await resolveReservationFamily(catalogItemId);
  const occupancy = await loadOccupancyContext(
    family,
    start.toISOString(),
    end.toISOString(),
    excludeReservationId
  );

  const capacity = schedule.capacity || 1;
  const { available, isBlocked } = availableSeatsForSlot(occupancy, start, end, capacity);
  if (isBlocked) {
    throw new Error('Slot overlaps with a calendar block');
  }
  if (available < quantity) {
    throw new Error(
      `Not enough capacity for this slot (requested ${quantity}, remaining ${available}, capacity ${capacity})`
    );
  }

  return {
    start_utc: start.toISOString(),
    end_utc: end.toISOString(),
  };
}
