import { supabaseAdmin } from '@/lib/database/supabase-client';
import { decryptApiKey } from '@/lib/services/api-keys/api-key-crypto';
import { VisitorAuthorizationError } from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';

interface StoredCredential {
  id: string;
  key_hash: string;
  user_id: string;
  site_id: string | null;
  scopes: string[];
  status: string;
  expires_at: string;
  identity_token_version: string;
}

const columns = 'id, key_hash, user_id, site_id, scopes, status, expires_at, identity_token_version';

function forbidden(): never {
  throw new VisitorAuthorizationError('CREDENTIAL_FORBIDDEN', 'Current credentials do not authorize this stream', 403);
}

function unavailable(): never {
  throw new VisitorAuthorizationError('AUTHORIZATION_UNAVAILABLE', 'Credential authorization is unavailable', 503);
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function bearerExpiresAt(token: string): number {
  try {
    const part = token.split('.')[1];
    const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof claims.exp === 'number' && Number.isFinite(claims.exp)) return claims.exp * 1000;
  } catch { /* The Auth provider still verifies the signature and revocation. */ }
  return forbidden();
}

async function assertUserSite(userId: string, siteId: string) {
  // Do not reuse canAccessSite: its positive membership cache can outlive access.
  const { data: site, error: siteError } = await supabaseAdmin.from('sites')
    .select('id').eq('id', siteId).eq('user_id', userId).maybeSingle();
  if (siteError) unavailable();
  if (site) return;
  const { data: owner, error: ownerError } = await supabaseAdmin.from('site_ownership')
    .select('site_id').eq('site_id', siteId).eq('user_id', userId).maybeSingle();
  if (ownerError) unavailable();
  if (owner) return;
  const { data: member, error: memberError } = await supabaseAdmin.from('site_members')
    .select('site_id').eq('site_id', siteId).eq('user_id', userId).eq('status', 'active').maybeSingle();
  if (memberError) unavailable();
  if (!member) forbidden();
}

async function databaseCredential(key: string): Promise<StoredCredential> {
  const [prefix] = key.split('_');
  if (key.length > 512 || !prefix || prefix.length > 8) forbidden();
  const lookup = await digest(key);
  const { data, error } = await supabaseAdmin.from('api_keys').select(columns)
    .eq('lookup_hash', lookup).maybeSingle();
  if (error) unavailable();
  let candidates: StoredCredential[] = data ? [data] : [];
  if (!data) {
    // Preserve bounded legacy-key support, but still decrypt the exact material.
    const { data: legacy, error: legacyError } = await supabaseAdmin.from('api_keys')
      .select(columns).eq('prefix', prefix).is('lookup_hash', null).limit(25);
    if (legacyError) unavailable();
    candidates = legacy || [];
  }
  for (const candidate of candidates) {
    let matches = false;
    try { matches = await digest(await decryptApiKey(candidate.key_hash)) === lookup; }
    catch { /* Missing or invalid encrypted material cannot authenticate a key. */ }
    if (!matches) continue;
    const expiry = Date.parse(candidate.expires_at);
    if (candidate.status !== 'active' || !Number.isFinite(expiry) || expiry <= Date.now()
      || !candidate.id || !candidate.user_id || !candidate.identity_token_version
      || !Array.isArray(candidate.scopes)
      || (!candidate.scopes.includes('read') && !candidate.scopes.includes('*'))) forbidden();
    return candidate;
  }
  return forbidden();
}

/** Reauthenticate immutable original proof; never cache a positive authorization. */
export async function createCredentialRevalidation(request: Request, siteId: string) {
  const apiKey = request.headers.get('x-api-key');
  const authorization = request.headers.get('authorization');
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  const original = apiKey || bearer || authorization;
  if (!original || original.length > 4096 || /\s/.test(original)) forbidden();
  const credential = original;
  const assertFresh = (expiry = Infinity) => {
    if (request.signal.aborted) throw new Error('Connection closed');
    if (Date.now() >= expiry) forbidden();
  };

  const authenticate = async () => {
    assertFresh();
    // The environment is deliberately read on every check, not captured at open.
    const serviceKey = process.env.SERVICE_API_KEY?.trim();
    if (serviceKey && credential === serviceKey) return {
      principal: JSON.stringify({ kind: 'service' }),
      assertFresh: () => {
        assertFresh();
        if (process.env.SERVICE_API_KEY?.trim() !== credential) forbidden();
      },
    };
    if (!apiKey && bearer && credential.includes('.')) {
      const expiry = bearerExpiresAt(credential);
      assertFresh(expiry);
      // Passing the original JWT explicitly forces an Auth server validation,
      // rather than reading a cached client session or middleware user metadata.
      const { data, error } = await supabaseAdmin.auth.getUser(credential);
      if (error || !data.user?.id || data.user.is_anonymous || data.user.role !== 'authenticated') forbidden();
      await assertUserSite(data.user.id, siteId);
      return { principal: JSON.stringify({ kind: 'user', userId: data.user.id }), assertFresh: () => assertFresh(expiry) };
    }
    const current = await databaseCredential(credential);
    if (current.site_id) {
      if (current.site_id !== siteId) forbidden();
    } else {
      await assertUserSite(current.user_id, siteId);
    }
    return {
      principal: JSON.stringify({
        kind: 'api-key', id: current.id, userId: current.user_id, siteId: current.site_id,
        version: current.identity_token_version,
      }),
      assertFresh: () => assertFresh(Date.parse(current.expires_at)),
    };
  };

  const initial = await authenticate();
  initial.assertFresh();
  return async () => {
    const current = await authenticate();
    if (current.principal !== initial.principal) {
      throw new VisitorAuthorizationError('IDENTITY_CHANGED', 'Credential identity changed', 403);
    }
    current.assertFresh();
    // Recheck lifetime after the caller's awaited conversation/grant lookups too.
    return current.assertFresh;
  };
}