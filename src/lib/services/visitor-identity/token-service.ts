import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { VisitorIdentityError } from './contracts';
import { IdentityTokenClaims } from './token-crypto';

export async function exchangeIdentityToken(claims: IdentityTokenClaims, token: string) {
  const { data, error } = await supabaseAdmin.rpc('exchange_visitor_identity_token_v2', {
    p_site_id: claims.site_id, p_session_id: claims.session_id, p_visitor_id: claims.visitor_id,
    p_issuer: claims.iss, p_subject: claims.sub, p_epoch: claims.epoch, p_jti: claims.jti,
    p_issued_at: claims.iat, p_expires_at: claims.exp,
    p_token_hash: createHash('sha256').update(token).digest('hex'),
    p_name: claims.name || null, p_email: claims.email || null,
    p_key_id: claims.key_id || null,
    p_key_fingerprint: claims.key_fingerprint || null,
    p_key_version: claims.key_version || null,
  });
  if (error || !data) throw new VisitorIdentityError('identity_storage_error', 'Identity exchange is unavailable', 503);
  if (data.status === 'verified' && typeof data.lead_id === 'string') {
    return { identity_status: 'verified' as const, lead_id: data.lead_id, expires_at: data.expires_at };
  }
  if (data.status === 'identity_conflict') {
    throw new VisitorIdentityError('identity_conflict', 'Log out before changing the session identity', 409);
  }
  throw new VisitorIdentityError('identity_token_revoked', 'Identity token is expired, revoked, or no longer active', 401);
}

export async function readCurrentIdentity(session: {
  siteId: string; sessionId: string; visitorId: string; leadId: string | null;
}) {
  if (!session.leadId) return { identity_status: 'anonymous' as const };
  const { data, error } = await supabaseAdmin.from('visitor_session_identity_grants')
    .select('lead_id, expires_at').eq('site_id', session.siteId).eq('session_id', session.sessionId)
    .eq('visitor_id', session.visitorId).eq('lead_id', session.leadId).is('revoked_at', null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`).maybeSingle();
  if (error) throw new VisitorIdentityError('identity_storage_error', 'Identity status is unavailable', 503);
  return data ? { identity_status: 'verified' as const, lead_id: data.lead_id, expires_at: data.expires_at }
    : { identity_status: 'anonymous' as const };
}