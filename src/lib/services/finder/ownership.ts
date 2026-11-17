import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export class FinderError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Verify the bearer ourselves; middleware headers and service keys are not actors. */
export async function requireFinderActor(request: Request) {
  const match = /^Bearer ([A-Za-z0-9._~+/-]{32,4096}={0,2})$/i.exec(request.headers.get('authorization') || '');
  if (!match || request.headers.has('x-api-key')) {
    throw new FinderError(401, 'An authenticated user bearer token is required.');
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) throw new FinderError(503, 'User authorization is unavailable.');
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${match[1]}` } },
  });
  const { data, error } = await client.auth.getUser(match[1]);
  if (error && (!error.status || error.status >= 500)) {
    throw new FinderError(503, 'User authorization is unavailable.');
  }
  if (error || !data?.user?.id || data.user.is_anonymous || data.user.role !== 'authenticated') {
    throw new FinderError(401, 'User session is invalid or expired.');
  }
  return { client, userId: data.user.id };
}

export async function requireFinderPermission(client: SupabaseClient, siteId: string, operation: 'insert' | 'delete') {
  const { data, error } = await client.rpc('user_can', { p_site_id: siteId, p_command: operation });
  if (error) throw new FinderError(503, 'Finder authorization is unavailable.');
  if (data !== true) throw new FinderError(403, 'Finder operation is not permitted.');
}

export async function authorizeFinderCreate(client: SupabaseClient, siteId: string, userId: string, segmentId?: string) {
  const { data: site, error: siteError } = await client.from('sites').select('id').eq('id', siteId).maybeSingle();
  if (siteError) throw new FinderError(503, 'Finder authorization is unavailable.');
  if (!site) throw new FinderError(404, 'Site not found.');
  const { data: access, error: accessError } = await client.rpc('finder_list_row_access', { p_site: siteId, p_user: userId });
  const { data: restricted, error: locationError } = await client.rpc('current_user_has_site_location_restrictions', { p_site_id: siteId });
  const { data: globallyRestricted, error: globalError } = await client.rpc('current_user_has_location_restrictions');
  if (accessError || locationError || globalError) throw new FinderError(503, 'Finder authorization is unavailable.');
  if (access !== true || restricted !== false || globallyRestricted !== false) throw new FinderError(403, 'Finder operation is not permitted.');
  await requireFinderPermission(client, siteId, 'insert');
  if (segmentId) {
    const { data, error } = await client.from('segments').select('id').eq('id', segmentId).eq('site_id', siteId).maybeSingle();
    if (error) throw new FinderError(503, 'Finder authorization is unavailable.');
    if (!data) throw new FinderError(404, 'Segment not found.');
  }
}

export function finderFailure(error: unknown) {
  return NextResponse.json({ error: error instanceof FinderError ? error.message : 'Finder request failed.' },
    { status: error instanceof FinderError ? error.status : 500 });
}