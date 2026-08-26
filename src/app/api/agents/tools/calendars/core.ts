import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { filterBookableFamily } from '@/lib/helpers/catalog-bookable';
import { normalizeWeeklyAvailability, type WeeklyAvailability } from '@/lib/reservations/weekly-hours';

export type CalendarsAction =
  | 'list'
  | 'get'
  | 'update_member_calendar'
  | 'update_team_calendar'
  | 'update_service_schedule';

export type CalendarsToolBody = {
  action: CalendarsAction;
  site_id?: string;
  query?: string;
  user_id?: string;
  calendar_id?: string;
  catalog_item_id?: string;
  enabled?: boolean;
  timezone?: string;
  availability?: WeeklyAvailability | string;
  days?: WeeklyAvailability | string;
  event_types?: unknown[];
  slug?: string;
  name?: string;
  member_ids?: string[];
  duration?: number;
  buffer?: number;
  duration_minutes?: number;
  capacity?: number;
};

type RoleMap = Map<string, string>;

function matchesQuery(query: string | undefined, ...values: Array<string | null | undefined>): boolean {
  if (!query) return true;
  const needle = query.toLowerCase().trim();
  if (!needle) return true;
  return values.some((value) => (value || '').toLowerCase().includes(needle));
}

async function loadSiteRoles(siteId: string): Promise<RoleMap> {
  const [ownersRes, membersRes] = await Promise.all([
    supabaseAdmin.from('site_ownership').select('user_id').eq('site_id', siteId),
    supabaseAdmin.from('site_members').select('user_id, role').eq('site_id', siteId),
  ]);

  if (ownersRes.error) throw new Error(`Failed to load site owners: ${ownersRes.error.message}`);
  if (membersRes.error) throw new Error(`Failed to load site members: ${membersRes.error.message}`);

  const roles: RoleMap = new Map();
  for (const owner of ownersRes.data || []) {
    if (owner.user_id) roles.set(owner.user_id, 'owner');
  }
  for (const member of membersRes.data || []) {
    if (member.user_id && !roles.has(member.user_id)) {
      roles.set(member.user_id, member.role || 'member');
    }
  }
  return roles;
}

function mapTeamMember(profile: any, role: string) {
  const settings = profile?.settings && typeof profile.settings === 'object' ? profile.settings : {};
  const calendar = settings.calendar && typeof settings.calendar === 'object' ? settings.calendar : null;
  return {
    user_id: profile.id,
    name: profile.name || null,
    email: profile.email || null,
    role,
    calendar: calendar
      ? {
          enabled: Boolean(calendar.enabled),
          timezone: calendar.timezone || null,
          slug: calendar.slug || null,
          availability: calendar.availability || null,
          event_types: calendar.event_types || [],
        }
      : null,
  };
}

async function loadTeamMembers(siteId: string, query?: string) {
  const roles = await loadSiteRoles(siteId);
  const userIds = Array.from(roles.keys());
  if (userIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, name, settings')
    .in('id', userIds);

  if (error) throw new Error(`Failed to load profiles: ${error.message}`);

  return (data || [])
    .map((profile) => mapTeamMember(profile, roles.get(profile.id) || 'member'))
    .filter((member) => matchesQuery(query, member.name, member.email));
}

async function loadSiteSettings(siteId: string) {
  const { data, error } = await supabaseAdmin
    .from('settings')
    .select('*')
    .eq('site_id', siteId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load site settings: ${error.message}`);
  return data || {};
}

async function loadReservableServices(siteId: string, query?: string) {
  const [itemsRes, schedulesRes] = await Promise.all([
    supabaseAdmin
      .from('catalog_items')
      .select('id, name, kind, status, availability_status, is_reservation, target_sale_price, currency, parent_id')
      .eq('site_id', siteId)
      .eq('is_reservation', true),
    supabaseAdmin
      .from('reservation_schedules')
      .select('id, catalog_item_id, name, timezone, duration_minutes, capacity, days')
      .eq('site_id', siteId),
  ]);

  if (itemsRes.error) throw new Error(`Failed to load reservable services: ${itemsRes.error.message}`);
  if (schedulesRes.error) throw new Error(`Failed to load reservation schedules: ${schedulesRes.error.message}`);

  const schedulesByItem = new Map((schedulesRes.data || []).map((row: any) => [row.catalog_item_id, row]));

  return filterBookableFamily(itemsRes.data || [])
    .filter((item: any) => matchesQuery(query, item.name))
    .map((item: any) => ({
      catalog_item_id: item.id,
      name: item.name,
      kind: item.kind,
      status: item.status,
      availability_status: item.availability_status,
      target_sale_price: item.target_sale_price,
      currency: item.currency,
      schedule: schedulesByItem.get(item.id) || null,
    }));
}

function directoryHint() {
  return [
    'Use update_member_calendar to set a person\'s working hours (profiles.settings.calendar).',
    'Use update_team_calendar for round-robin team calendars (settings.calendars).',
    'Use update_service_schedule for catalog reservable items (reservation_schedules).',
    'Times are 24h HH:mm. Example: 8pm = 20:00. Lunch is availability.monday.breaks: [{ start: "15:00", end: "16:00" }].',
    'scheduling only books a specific appointment; it does not change weekly hours.',
  ].join(' ');
}

async function listDirectory(siteId: string, query?: string) {
  const [team_members, settings, reservable_services] = await Promise.all([
    loadTeamMembers(siteId, query),
    loadSiteSettings(siteId),
    loadReservableServices(siteId),
  ]);

  const team_calendars = Array.isArray(settings.calendars) ? settings.calendars : [];
  const matching_team_calendars = query
    ? team_calendars.filter((calendar: any) => matchesQuery(query, calendar?.name, calendar?.slug))
    : team_calendars;
  const matching_services = query
    ? reservable_services.filter((item: any) => matchesQuery(query, item.name))
    : reservable_services;

  return {
    success: true,
    query: query || null,
    business_hours: settings.business_hours || null,
    team_members,
    team_calendars,
    reservable_services,
    matches: query
      ? {
          team_members: team_members.map((member: any) => member.user_id),
          team_calendars: matching_team_calendars.map((calendar: any) => calendar.id).filter(Boolean),
          reservable_services: matching_services.map((item: any) => item.catalog_item_id),
        }
      : null,
    hint: directoryHint(),
  };
}

async function resolveMembers(siteId: string, userId?: string, query?: string) {
  const members = await loadTeamMembers(siteId, userId ? undefined : query);
  if (userId) {
    const match = members.find((member) => member.user_id === userId);
    return match ? [match] : [];
  }
  return members;
}

async function getDirectory(siteId: string, body: CalendarsToolBody) {
  if (!body.query && !body.user_id && !body.catalog_item_id && !body.calendar_id) {
    throw new Error('get requires query, user_id, catalog_item_id, or calendar_id');
  }

  const directory = await listDirectory(siteId, body.query);
  const team_members = body.user_id
    ? directory.team_members.filter((member: any) => member.user_id === body.user_id)
    : directory.team_members;
  const reservable_services = body.catalog_item_id
    ? directory.reservable_services.filter((item: any) => item.catalog_item_id === body.catalog_item_id)
    : directory.reservable_services;
  const team_calendars = body.calendar_id
    ? directory.team_calendars.filter((calendar: any) => calendar.id === body.calendar_id)
    : directory.team_calendars;

  return {
    success: true,
    team_members,
    team_calendars,
    reservable_services,
    business_hours: directory.business_hours,
    hint: directoryHint(),
  };
}

async function updateMemberCalendar(siteId: string, body: CalendarsToolBody) {
  const matches = await resolveMembers(siteId, body.user_id, body.query);
  if (matches.length === 0) {
    const all = await loadTeamMembers(siteId);
    throw new Error(
      `No team member matched. Known members: ${all.map((m) => `${m.name || 'unnamed'} <${m.email || m.user_id}>`).join(', ') || '(none)'}`
    );
  }
  if (matches.length > 1) {
    return {
      success: false,
      error: 'Multiple team members matched. Pass user_id to disambiguate.',
      matches: matches.map((member) => ({
        user_id: member.user_id,
        name: member.name,
        email: member.email,
        role: member.role,
      })),
    };
  }

  const member = matches[0];
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, settings')
    .eq('id', member.user_id)
    .single();

  if (profileError || !profile) throw new Error('Profile not found for team member');

  const existingSettings = profile.settings && typeof profile.settings === 'object' ? profile.settings : {};
  const existingCalendar =
    existingSettings.calendar && typeof existingSettings.calendar === 'object' ? existingSettings.calendar : {};

  const availabilityInput = body.availability ?? body.days;
  const nextCalendar: Record<string, unknown> = {
    ...existingCalendar,
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : existingCalendar.enabled ?? true,
    timezone: body.timezone || existingCalendar.timezone || 'America/Mexico_City',
  };

  if (availabilityInput) {
    nextCalendar.availability = normalizeWeeklyAvailability(availabilityInput);
  }
  if (body.event_types) nextCalendar.event_types = body.event_types;
  if (body.slug) nextCalendar.slug = body.slug;
  if (body.name) nextCalendar.name = body.name;

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({
      settings: {
        ...existingSettings,
        calendar: nextCalendar,
      },
    })
    .eq('id', member.user_id)
    .select('id, email, name, settings')
    .single();

  if (error) throw new Error(`Failed to update member calendar: ${error.message}`);

  return {
    success: true,
    team_member: mapTeamMember(data, member.role),
    hint: 'Personal calendar saved on profiles.settings.calendar. Appointments still use tasks type=meeting.',
  };
}

async function updateTeamCalendar(siteId: string, body: CalendarsToolBody) {
  const settings = await loadSiteSettings(siteId);
  const calendars = Array.isArray(settings.calendars) ? [...settings.calendars] : [];
  const existingIndex = body.calendar_id
    ? calendars.findIndex((calendar: any) => calendar.id === body.calendar_id)
    : body.slug
      ? calendars.findIndex((calendar: any) => calendar.slug === body.slug)
      : -1;

  const existing = existingIndex >= 0 ? calendars[existingIndex] : {};
  const next = {
    ...existing,
    id: existing.id || body.calendar_id || randomUUID(),
    name: body.name || existing.name,
    slug: body.slug || existing.slug || (body.name ? String(body.name).toLowerCase().replace(/\s+/g, '-') : undefined),
    member_ids: body.member_ids || existing.member_ids || [],
    duration: body.duration ?? existing.duration ?? 30,
    buffer: body.buffer ?? existing.buffer ?? 0,
    timezone: body.timezone || existing.timezone || 'America/Mexico_City',
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : existing.enabled ?? true,
  };

  if (!next.name) throw new Error('Team calendar requires name (or an existing calendar_id to update).');

  if (existingIndex >= 0) calendars[existingIndex] = next;
  else calendars.push(next);

  const payload = {
    site_id: siteId,
    calendars,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = settings.id
    ? await supabaseAdmin.from('settings').update(payload).eq('site_id', siteId).select('calendars').single()
    : await supabaseAdmin.from('settings').insert(payload).select('calendars').single();

  if (error) throw new Error(`Failed to update team calendars: ${error.message}`);

  return {
    success: true,
    team_calendar: next,
    team_calendars: data?.calendars || calendars,
  };
}

async function updateServiceSchedule(siteId: string, body: CalendarsToolBody) {
  if (!body.catalog_item_id) throw new Error('catalog_item_id is required for update_service_schedule');
  const availabilityInput = body.availability ?? body.days;
  if (!availabilityInput) throw new Error('availability/days is required for update_service_schedule');
  if (!body.timezone) throw new Error('timezone is required for update_service_schedule');

  const { data: item, error: itemError } = await supabaseAdmin
    .from('catalog_items')
    .select('id, name, site_id, is_reservation')
    .eq('id', body.catalog_item_id)
    .single();

  if (itemError || !item) throw new Error('Catalog item not found');
  if (item.site_id !== siteId) throw new Error('Catalog item does not belong to this site');
  if (!item.is_reservation) throw new Error('Catalog item is not reservable (is_reservation=false)');

  const days = normalizeWeeklyAvailability(availabilityInput);
  const payload = {
    site_id: siteId,
    catalog_item_id: body.catalog_item_id,
    timezone: body.timezone,
    days,
    duration_minutes: body.duration_minutes ?? body.duration ?? 60,
    capacity: body.capacity ?? 1,
    name: body.name || item.name,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('reservation_schedules')
    .upsert(payload, { onConflict: 'catalog_item_id' })
    .select()
    .single();

  if (error) throw new Error(`Failed to update service schedule: ${error.message}`);

  return {
    success: true,
    reservable_service: {
      catalog_item_id: item.id,
      name: item.name,
      schedule: data,
    },
  };
}

export async function calendarsCore(body: CalendarsToolBody) {
  const { action, site_id: siteId } = body;
  if (!action) throw new Error('Missing action');
  if (!siteId) throw new Error('Missing site_id');

  if (action === 'list') return listDirectory(siteId, body.query);
  if (action === 'get') return getDirectory(siteId, body);
  if (action === 'update_member_calendar') return updateMemberCalendar(siteId, body);
  if (action === 'update_team_calendar') return updateTeamCalendar(siteId, body);
  if (action === 'update_service_schedule') return updateServiceSchedule(siteId, body);

  throw new Error(
    `Invalid action "${action}". Use list, get, update_member_calendar, update_team_calendar, or update_service_schedule.`
  );
}
