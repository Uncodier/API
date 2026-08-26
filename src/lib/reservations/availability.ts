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

export async function getAvailableSlots(
  catalogItemId: string,
  startDateStr: string,
  endDateStr: string,
  qty: number = 1
) {
  // 1. Get schedule
  const { data: schedule } = await supabaseAdmin
    .from('reservation_schedules')
    .select('*')
    .eq('catalog_item_id', catalogItemId)
    .single();

  if (!schedule) return [];

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
    .eq('catalog_item_id', catalogItemId)
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
        const applies = b.entity_type === 'global' || (b.entity_type === 'catalog_item' && b.entity_id === catalogItemId);
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

  return result;
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
