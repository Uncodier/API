import { supabaseAdmin } from '@/lib/database/supabase-client';
import { DEFAULT_TIMEZONE, normalizeTimezone } from './constants';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value?: string | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

async function fetchProfileTimezone(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('timezone')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.warn('[timezone] Failed to load profiles.timezone:', error.message);
    return null;
  }

  return typeof data?.timezone === 'string' ? data.timezone : null;
}

async function fetchSiteOwnerId(siteId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('sites')
    .select('user_id')
    .eq('id', siteId)
    .maybeSingle();

  if (error) {
    console.warn('[timezone] Failed to load sites.user_id:', error.message);
    return null;
  }

  return typeof data?.user_id === 'string' ? data.user_id : null;
}

/**
 * Canonical client timezone: profiles.timezone.
 * Falls back to the site owner's profile, then America/Mexico_City.
 */
export async function resolveClientTimezone(params: {
  userId?: string | null;
  siteId?: string | null;
} = {}): Promise<string> {
  const { userId, siteId } = params;

  if (isUuid(userId)) {
    const fromUser = await fetchProfileTimezone(userId);
    if (fromUser) return normalizeTimezone(fromUser);
  }

  if (isUuid(siteId)) {
    const ownerId = await fetchSiteOwnerId(siteId);
    if (isUuid(ownerId)) {
      const fromOwner = await fetchProfileTimezone(ownerId);
      if (fromOwner) return normalizeTimezone(fromOwner);
    }
  }

  return DEFAULT_TIMEZONE;
}

export async function resolveUserTimezone(userId?: string | null): Promise<string> {
  return resolveClientTimezone({ userId });
}
