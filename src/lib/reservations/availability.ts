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
    .gte('end_time', start.toISOString())
    .lte('start_time', end.toISOString());

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
  const { data: reservations } = await supabaseAdmin
    .from('reservations')
    .select('start_time, end_time, quantity, status')
    .eq('catalog_item_id', catalogItemId)
    .in('status', ['pending', 'confirmed'])
    .gte('start_time', startOfDay(parseISO(startDateStr)).toISOString())
    .lte('end_time', endOfDay(parseISO(endDateStr)).toISOString());

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

      // Calculate booked seats
      const booked = (reservations || []).filter((r: any) => {
        const rStart = new Date(r.start_time);
        const rEnd = new Date(r.end_time);
        return isBefore(current, rEnd) && isAfter(slotEnd, rStart);
      }).reduce((acc: number, r: any) => acc + (r.quantity || 1), 0);

      const available = capacity - booked;

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

  const booked = await getBookedSeats(catalogItemId, start, end);
  if (schedule.capacity - booked < quantity) {
    throw new Error('Not enough capacity for this slot');
  }

  return true;
}
