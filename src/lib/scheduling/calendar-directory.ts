import { supabaseAdmin } from '@/lib/database/supabase-client';
import type { WeeklyAvailability } from '@/lib/reservations/weekly-hours';
import { DEFAULT_TIMEZONE, normalizeTimezone } from '@/lib/timezone/constants';

export type MemberCalendar = {
  enabled?: boolean;
  timezone?: string;
  availability?: WeeklyAvailability;
};

export type SchedulingMember = {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  calendar?: MemberCalendar | null;
};

export type TeamCalendar = {
  id: string;
  name?: string;
  enabled?: boolean;
  member_ids?: string[];
  timezone?: string;
  buffer?: number;
};

export class SchedulingAvailabilityError extends Error {
  constructor(public code: string, message: string, public status = 422) {
    super(message);
    this.name = 'SchedulingAvailabilityError';
  }
}

export function schedulingDatabase() {
  return supabaseAdmin.schema(
    process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public'
  );
}

/** Load only scheduling data; unavailable catalog services must not block appointments. */
export async function loadSchedulingDirectory(siteId: string) {
  const db = schedulingDatabase();
  const [settings, owners, members] = await Promise.all([
    db.from('settings').select('calendars, business_hours').eq('site_id', siteId).maybeSingle(),
    db.from('site_ownership').select('user_id').eq('site_id', siteId),
    db.from('site_members').select('user_id, role, status').eq('site_id', siteId).eq('status', 'active'),
  ]);
  if (settings.error || owners.error || members.error) {
    throw new SchedulingAvailabilityError('CALENDAR_LOOKUP_FAILED', 'No se pudieron consultar los calendarios del sitio', 503);
  }
  const roles = new Map<string, string>();
  for (const row of members.data || []) if (row.user_id && row.status === 'active') roles.set(row.user_id, row.role || 'member');
  for (const row of owners.data || []) if (row.user_id) roles.set(row.user_id, 'owner');
  let profiles: SchedulingMember[] = [];
  let timezone = DEFAULT_TIMEZONE;
  if (roles.size) {
    // Never resolve an email or user identifier outside the site's membership boundary.
    const result = await db.from('profiles').select('id, name, email, settings, timezone').in('id', [...roles.keys()]);
    if (result.error) {
      throw new SchedulingAvailabilityError('CALENDAR_LOOKUP_FAILED', 'No se pudieron consultar los miembros del calendario', 503);
    }
    timezone = normalizeTimezone((result.data || []).find((profile: any) => roles.get(profile.id) === 'owner')?.timezone);
    profiles = (result.data || []).map((profile: any) => ({
      id: profile.id, name: profile.name || null, email: profile.email || null,
      role: roles.get(profile.id) || 'member', calendar: profile.settings?.calendar
        ? { ...profile.settings.calendar, timezone: profile.settings.calendar.timezone || profile.timezone || timezone }
        : null,
    }));
  }
  return {
    members: profiles,
    calendars: (Array.isArray(settings.data?.calendars) ? settings.data.calendars : []) as TeamCalendar[],
    businessHours: settings.data?.business_hours,
    timezone,
  };
}

/** Legacy calendar member references can be emails, but only a unique site member is valid. */
export function resolveCalendarMembers(calendar: TeamCalendar, members: SchedulingMember[]): SchedulingMember[] {
  const refs = calendar.member_ids;
  if (!Array.isArray(refs) || !refs.length) {
    throw new SchedulingAvailabilityError('CALENDAR_NOT_CONFIGURED', 'El calendario no tiene miembros configurados');
  }
  const resolved = refs.map(ref => {
    const matches = members.filter(member => typeof ref === 'string' && (
      member.id === ref || member.email?.toLowerCase() === ref.trim().toLowerCase()
    ));
    if (matches.length !== 1) {
      throw new SchedulingAvailabilityError('CALENDAR_NOT_CONFIGURED', 'Un miembro del calendario no se pudo resolver dentro del sitio');
    }
    return matches[0];
  });
  return [...new Map(resolved.map(member => [member.id, member])).values()];
}