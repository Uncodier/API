import { createClient } from '@supabase/supabase-js';
import { isSiteSkillManager } from '@/lib/services/site-skill-access';
import { SiteSetupError } from './setup-request';

export async function authenticateSetupUser(request: Request): Promise<string> {
  const authorization = request.headers.get('authorization') || '';
  if (request.headers.has('x-api-key') || !/^Bearer [^\s]{32,4096}$/.test(authorization)) {
    throw new SiteSetupError(401, 'UNAUTHORIZED', 'An authenticated user bearer token is required');
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new SiteSetupError(503, 'AUTHORIZATION_UNAVAILABLE', 'User authorization is unavailable');
  }

  // Match the safe user-token route pattern; never trust middleware identity headers.
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  let result;
  try {
    result = await client.auth.getUser(authorization.slice(7));
  } catch {
    throw new SiteSetupError(503, 'AUTHORIZATION_UNAVAILABLE', 'User authorization is unavailable');
  }
  const user = result.data?.user;
  if (result.error || !user || user.is_anonymous || user.role !== 'authenticated') {
    throw new SiteSetupError(401, 'UNAUTHORIZED', 'User session is invalid or expired');
  }
  return user.id;
}

export async function authorizeSetupManager(siteId: string, userId: string): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await isSiteSkillManager(siteId, userId);
  } catch {
    throw new SiteSetupError(503, 'AUTHORIZATION_UNAVAILABLE', 'Site authorization is unavailable');
  }
  if (!allowed) {
    throw new SiteSetupError(403, 'FORBIDDEN', 'Site setup requires owner or admin access');
  }
}