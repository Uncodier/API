import { supabaseAdmin } from '@/lib/database/supabase-client';
import { DEFAULT_TIMEZONE, formatInTimezone, resolveClientTimezone } from '@/lib/timezone';

const INACTIVE_RESERVATION_STATUSES = ['cancelled', 'canceled', 'failed', 'expired'];
const INACTIVE_TASK_STATUSES = ['completed', 'failed', 'cancelled', 'canceled'];
const INACTIVE_APPOINTMENT_STATUSES = ['cancelled', 'canceled'];

export interface LeadAppointmentRow {
  id: string;
  title?: string | null;
  start_datetime?: string | null;
  end_datetime?: string | null;
  status?: string | null;
  timezone?: string | null;
  participants?: string[] | null;
}

export interface LeadReservationRow {
  id: string;
  start_time?: string | null;
  end_time?: string | null;
  status?: string | null;
  catalog_item_id?: string | null;
  catalog_item?: { name?: string | null } | { name?: string | null }[] | null;
}

export interface LeadMeetingTaskRow {
  id: string;
  title?: string | null;
  scheduled_date?: string | null;
  status?: string | null;
  type?: string | null;
}

export interface LeadOrderRow {
  id: string;
  title?: string | null;
  status?: string | null;
  amount?: number | null;
  currency?: string | null;
}

export interface LeadRecordSnapshot {
  appointments: LeadAppointmentRow[];
  reservations: LeadReservationRow[];
  meetingTasks: LeadMeetingTaskRow[];
  orders: LeadOrderRow[];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function safeQuery<T>(label: string, run: () => Promise<T[]>, fallback: T[] = []): Promise<T[]> {
  try {
    return await run();
  } catch (error) {
    console.error(`[LeadRecord] Failed to load ${label}:`, error);
    return fallback;
  }
}

async function loadAppointments(leadId: string, siteId?: string | null): Promise<LeadAppointmentRow[]> {
  let query = supabaseAdmin
    .from('appointments')
    .select('id, title, start_datetime, end_datetime, status, timezone, participants')
    .eq('context_id', leadId)
    .not('status', 'in', `(${INACTIVE_APPOINTMENT_STATUSES.join(',')})`)
    .order('start_datetime', { ascending: true })
    .limit(20);

  if (siteId && isUuid(siteId)) {
    query = query.eq('site_id', siteId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []) as LeadAppointmentRow[];
}

async function loadReservations(leadId: string, siteId?: string | null): Promise<LeadReservationRow[]> {
  let query = supabaseAdmin
    .from('reservations')
    .select('id, start_time, end_time, status, catalog_item_id, catalog_item:catalog_items(name, site_id)')
    .eq('lead_id', leadId)
    .not('status', 'in', `(${INACTIVE_RESERVATION_STATUSES.join(',')})`)
    .order('start_time', { ascending: true })
    .limit(20);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = (data || []) as LeadReservationRow[];
  if (!siteId || !isUuid(siteId)) return rows;

  return rows.filter((row) => {
    const item = Array.isArray(row.catalog_item) ? row.catalog_item[0] : row.catalog_item;
    const itemSiteId = (item as { site_id?: string } | null)?.site_id;
    return !itemSiteId || itemSiteId === siteId;
  });
}

async function loadMeetingTasks(leadId: string, siteId?: string | null): Promise<LeadMeetingTaskRow[]> {
  let query = supabaseAdmin
    .from('tasks')
    .select('id, title, scheduled_date, status, type')
    .eq('lead_id', leadId)
    .eq('type', 'meeting')
    .not('status', 'in', `(${INACTIVE_TASK_STATUSES.join(',')})`)
    .order('scheduled_date', { ascending: true })
    .limit(20);

  if (siteId && isUuid(siteId)) {
    query = query.eq('site_id', siteId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []) as LeadMeetingTaskRow[];
}

async function loadOrders(leadId: string, siteId?: string | null): Promise<LeadOrderRow[]> {
  let query = supabaseAdmin
    .from('sales')
    .select('id, title, status, amount, currency')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (siteId && isUuid(siteId)) {
    query = query.eq('site_id', siteId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []) as LeadOrderRow[];
}

export async function loadLeadRecordSnapshot(
  leadId: string,
  siteId?: string | null
): Promise<LeadRecordSnapshot> {
  if (!isUuid(leadId)) {
    return { appointments: [], reservations: [], meetingTasks: [], orders: [] };
  }

  const [appointments, reservations, meetingTasks, orders] = await Promise.all([
    safeQuery('appointments', () => loadAppointments(leadId, siteId)),
    safeQuery('reservations', () => loadReservations(leadId, siteId)),
    safeQuery('meeting tasks', () => loadMeetingTasks(leadId, siteId)),
    safeQuery('orders', () => loadOrders(leadId, siteId)),
  ]);

  return { appointments, reservations, meetingTasks, orders };
}

function catalogName(row: LeadReservationRow): string {
  const item = Array.isArray(row.catalog_item) ? row.catalog_item[0] : row.catalog_item;
  return item?.name || row.catalog_item_id || 'N/A';
}

function formatLocalInstant(iso: string | null | undefined, timezone: string): string {
  if (!iso) return 'N/A';
  const local = formatInTimezone(iso, timezone, 'yyyy-MM-dd HH:mm');
  return local ? `${local} ${timezone}` : iso;
}

export function formatLeadRecordForContext(
  snapshot: LeadRecordSnapshot,
  timezone: string = DEFAULT_TIMEZONE
): string {
  const tz = timezone || DEFAULT_TIMEZONE;
  const hasAny =
    snapshot.appointments.length > 0 ||
    snapshot.reservations.length > 0 ||
    snapshot.meetingTasks.length > 0 ||
    snapshot.orders.length > 0;

  let text = `\n\n=== LEAD RECORD (source of truth) ===\n`;
  text += `Times below are client local (${tz}). Storage is UTC; speak local hours to the customer. Copy start_utc when calling schedule/update.\n`;
  if (!hasAny) {
    text += `No active appointments, reservations, meeting tasks, or orders found for this lead.\n`;
    text += `Still look them up with tools before booking if the user asks to schedule or change a time.\n`;
    return text;
  }

  if (snapshot.appointments.length > 0) {
    text += `Appointments:\n`;
    for (const appt of snapshot.appointments) {
      const apptTz = appt.timezone || tz;
      text += `- id=${appt.id} title="${appt.title || 'N/A'}" local=${formatLocalInstant(appt.start_datetime, apptTz)}–${formatInTimezone(appt.end_datetime || '', apptTz, 'HH:mm') || 'N/A'} start_utc=${appt.start_datetime || 'N/A'} status=${appt.status || 'N/A'}\n`;
    }
  }

  if (snapshot.reservations.length > 0) {
    text += `Reservations:\n`;
    for (const res of snapshot.reservations) {
      text += `- id=${res.id} item="${catalogName(res)}" local=${formatLocalInstant(res.start_time, tz)}–${formatInTimezone(res.end_time || '', tz, 'HH:mm') || 'N/A'} start_utc=${res.start_time || 'N/A'} status=${res.status || 'N/A'}\n`;
    }
  }

  if (snapshot.meetingTasks.length > 0) {
    text += `Meeting tasks:\n`;
    for (const task of snapshot.meetingTasks) {
      text += `- id=${task.id} title="${task.title || 'N/A'}" local=${formatLocalInstant(task.scheduled_date, tz)} status=${task.status || 'N/A'}\n`;
    }
  }

  if (snapshot.orders.length > 0) {
    text += `Orders:\n`;
    for (const order of snapshot.orders) {
      const amount = order.amount != null ? `${order.amount} ${order.currency || ''}`.trim() : 'N/A';
      text += `- id=${order.id} title="${order.title || 'N/A'}" status=${order.status || 'N/A'} amount=${amount}\n`;
    }
  }

  text += `If this lead already has an active appointment or reservation, reschedule/update that record — do not create a duplicate.\n`;
  return text;
}

export async function appendLeadRecordToContext(
  contextMessage: string,
  leadId: string,
  siteId?: string | null
): Promise<string> {
  const timezone = await resolveClientTimezone({ siteId });
  const snapshot = await loadLeadRecordSnapshot(leadId, siteId);
  return `${contextMessage}${formatLeadRecordForContext(snapshot, timezone)}`;
}
