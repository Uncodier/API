import { createClient } from '@supabase/supabase-js';
import { OutstandPostError } from './post-errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POST_ID = /^[A-Za-z0-9_-]{1,200}$/;

export function parsePostRequest(request: Request, id: string, remoteOnly = false) {
  if (!['GET', 'HEAD', 'DELETE'].includes(request.method) || (remoteOnly && request.method !== 'DELETE')) {
    throw new OutstandPostError(405, 'Method not allowed.');
  }
  const query = new URL(request.url).searchParams;
  const allowed = request.method !== 'DELETE' || remoteOnly ? ['tenant_id'] : ['tenant_id', 'delete_remote'];
  if (typeof id !== 'string' || id !== id.trim() || !POST_ID.test(id)
    || Array.from(query.keys()).some((key) => !allowed.includes(key))
    || allowed.some((key) => query.getAll(key).length > 1)) {
    throw new OutstandPostError(400, 'Invalid post ID or query parameters.');
  }
  const tenantId = query.get('tenant_id');
  if (!tenantId || tenantId !== tenantId.trim() || !UUID.test(tenantId)) {
    throw new OutstandPostError(400, 'A valid tenant_id is required.');
  }
  const remote = query.get('delete_remote');
  if (remote !== null && remote !== 'true' && remote !== 'false') {
    throw new OutstandPostError(400, 'delete_remote must be true or false.');
  }
  return { siteId: tenantId.toLowerCase(), deleteRemote: remoteOnly || remote === 'true' };
}

/** Never use middleware identity headers or the service-role fallback for this route. */
export async function requirePostSiteAccess(request: Request, siteId: string, signal: AbortSignal) {
  const authorization = request.headers.get('authorization') || '';
  if (request.headers.has('x-api-key') || !/^Bearer [^\s]{32,4096}$/.test(authorization)) {
    throw new OutstandPostError(401, 'An authenticated user bearer token is required.');
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new OutstandPostError(503, 'User authorization is unavailable.');
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: authorization },
      fetch: (input, options) => fetch(input, { ...options, signal, redirect: 'error' }),
    },
  });
  const { data, error } = await client.auth.getUser(authorization.slice(7));
  signal.throwIfAborted();
  if (error || !data.user || data.user.is_anonymous || data.user.role !== 'authenticated') {
    throw new OutstandPostError(401, 'User session is invalid or expired.');
  }
  const { data: role, error: roleError } = await client.rpc('current_user_site_role', { p_site_id: siteId });
  signal.throwIfAborted();
  if (roleError) throw new OutstandPostError(503, 'Site authorization is unavailable.');
  const roles = request.method === 'DELETE' ? ['owner', 'admin'] : ['owner', 'admin', 'marketing', 'collaborator'];
  if (typeof role !== 'string' || !roles.includes(role)) {
    throw new OutstandPostError(403, 'You do not have permission to perform this operation for this site.');
  }
  if (request.method === 'DELETE') {
    const { data: allowed, error: capabilityError } = await client.rpc('user_can', {
      p_site_id: siteId, p_command: 'delete',
    });
    signal.throwIfAborted();
    if (capabilityError) throw new OutstandPostError(503, 'Site authorization is unavailable.');
    if (allowed !== true) throw new OutstandPostError(403, 'Content deletion is not permitted for this site.');
  }
}