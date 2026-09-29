import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { decryptApiKey } from '@/lib/services/api-keys/api-key-crypto';
import { verifiedVisitorSessionClaims } from '@/lib/security/visitor-session-token';
import { VisitorIdentityError } from './contracts';
import { FIRST_PARTY_AUTH_URL } from './token-crypto';

export async function authenticateIdentityIssuer(request: Request) {
  const key = request.headers.get('x-api-key');
  // Browser callers must exchange tokens, not carry issuer credentials.
  if (request.headers.has('origin') || request.headers.has('sec-fetch-site')
    || request.headers.has('authorization') || !key || key.length > 512) {
    throw new VisitorIdentityError('issuer_required', 'A server-side scoped API key is required', 401);
  }
  const digest = createHash('sha256').update(key).digest('hex');
  // Deliberately bypass generic/global/service validation and its positive cache.
  const { data, error } = await supabaseAdmin.from('api_keys')
    .select('id, key_hash, site_id, scopes, status, expires_at, identity_token_version')
    .eq('lookup_hash', digest).maybeSingle();
  if (error) throw new VisitorIdentityError('identity_storage_error', 'Issuer validation is unavailable', 503);
  const expires = Date.parse(data?.expires_at || '');
  if (!data || data.status !== 'active' || !Number.isFinite(expires) || expires <= Date.now()
    || !data.site_id || !Array.isArray(data.scopes) || !data.scopes.includes('identity:issue')) {
    throw new VisitorIdentityError('issuer_forbidden', 'An active site-scoped identity:issue key is required', 403);
  }
  let matches = false;
  try {
    const stored = createHash('sha256').update(await decryptApiKey(data.key_hash)).digest();
    matches = timingSafeEqual(stored, Buffer.from(digest, 'hex'));
  } catch { /* Invalid encrypted material is not a valid issuer. */ }
  if (!matches) throw new VisitorIdentityError('issuer_forbidden', 'API key is invalid', 403);
  if (typeof data.identity_token_version !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.identity_token_version)) {
    throw new VisitorIdentityError('identity_configuration_error', 'Credential version is unavailable', 503);
  }
  return {
    siteId: String(data.site_id), issuer: `integration:${data.site_id}`, keyId: String(data.id),
    keyFingerprint: createHash('sha256').update(data.key_hash).digest('hex'),
    keyVersion: data.identity_token_version,
  };
}

export async function authenticateFirstPartyUser(request: Request) {
  const authorization = request.headers.get('authorization') || '';
  if (request.headers.has('x-api-key') || !/^Bearer [^\s]{32,4096}$/.test(authorization)) {
    throw new VisitorIdentityError('user_required', 'A first-party user session is required', 401);
  }
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new VisitorIdentityError('identity_configuration_error', 'User validation is unavailable', 503);
  const authClient = createClient(FIRST_PARTY_AUTH_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await authClient.auth.getUser(authorization.slice(7));
  if (error || !data.user || data.user.is_anonymous || data.user.role !== 'authenticated') {
    throw new VisitorIdentityError('user_required', 'User session is invalid or expired', 401);
  }
  return data.user;
}

export async function requireIdentitySession(request: Request, siteId: string, sessionId: string) {
  const token = request.headers.get('x-visitor-session-token');
  if (!token || token.length > 2048) {
    throw new VisitorIdentityError('session_proof_required', 'Visitor session proof is required', 401);
  }
  const claims = await verifiedVisitorSessionClaims(token, { siteId, sessionId });
  if (!claims) throw new VisitorIdentityError('session_forbidden', 'Visitor session proof is invalid', 403);
  const { data, error } = await supabaseAdmin.from('visitor_sessions')
    .select('id, site_id, visitor_id, lead_id, is_active')
    .eq('id', sessionId).eq('site_id', siteId).eq('visitor_id', claims.visitorId).maybeSingle();
  if (error) throw new VisitorIdentityError('identity_storage_error', 'Session validation is unavailable', 503);
  if (!data || !data.is_active) throw new VisitorIdentityError('invalid_session', 'Visitor session is inactive', 401);
  return { siteId, sessionId, visitorId: String(data.visitor_id), leadId: data.lead_id as string | null };
}

export async function identitySessionEpoch(sessionId: string): Promise<number> {
  const { data, error } = await supabaseAdmin.from('visitor_identity_session_state')
    .select('epoch').eq('session_id', sessionId).maybeSingle();
  if (error) throw new VisitorIdentityError('identity_storage_error', 'Identity state is unavailable', 503);
  return data?.epoch ?? 0;
}