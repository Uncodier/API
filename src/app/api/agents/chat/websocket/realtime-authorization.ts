import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  CanonicalVisitorIdentity, VisitorAuthorizationError, visitorSessionAuthorizationService,
} from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';
import { createCredentialRevalidation } from './credential-revalidation';

async function generation(identity: CanonicalVisitorIdentity) {
  const { data: state, error } = await supabaseAdmin.from('visitor_identity_session_state')
    .select('epoch').eq('session_id', identity.sessionId).maybeSingle();
  if (error) throw new VisitorAuthorizationError('AUTHORIZATION_UNAVAILABLE', 'Unable to authorize session generation', 503);
  let grantGeneration = null;
  if (identity.leadId) {
    const { data: grant, error: grantError } = await supabaseAdmin.from('visitor_session_identity_grants')
      .select('id, granted_at, expires_at').eq('site_id', identity.siteId)
      .eq('session_id', identity.sessionId).eq('visitor_id', identity.visitorId)
      .eq('lead_id', identity.leadId).is('revoked_at', null).maybeSingle();
    if (grantError || !grant || (grant.expires_at && !(Date.parse(grant.expires_at) > Date.now()))) {
      throw new VisitorAuthorizationError('IDENTITY_VERIFICATION_REQUIRED', 'An active identity grant is required', 403);
    }
    // Grants are upserted, so their id alone does not identify a login generation.
    grantGeneration = { id: grant.id, grantedAt: grant.granted_at };
  }
  return JSON.stringify({ epoch: state?.epoch ?? 0, grant: grantGeneration });
}

export async function createRevalidation(
  request: Request,
  siteId: string,
  sessionId: string | null,
  identity: CanonicalVisitorIdentity | null,
) {
  // Metadata may select the service path, but cannot prove its credentials. A
  // session-bearing service caller must also keep its original proof valid.
  const usesCredentials = !identity || request.headers.has('x-api-key')
    || request.headers.has('authorization') || request.headers.has('x-api-key-data')
    || request.headers.get('x-auth-validated') === 'true';
  const revalidateCredential = usesCredentials
    ? await createCredentialRevalidation(request, siteId) : null;
  // Canonical identity does not expose its private grant/session generation.
  const initialGeneration = identity ? await generation(identity) : null;
  const fingerprint = JSON.stringify(identity);
  return async (conversationId?: string) => {
    if (request.signal.aborted) throw new Error('Connection closed');
    const assertCredentialFresh = await revalidateCredential?.();
    const current = identity ? await visitorSessionAuthorizationService.authorizeBrowserRequest({
      request, siteId, sessionId, conversationId,
    }) : null;
    if (JSON.stringify(current) !== fingerprint) {
      throw new VisitorAuthorizationError('IDENTITY_CHANGED', 'Session identity changed', 403);
    }
    if (current && await generation(current) !== initialGeneration) {
      throw new VisitorAuthorizationError('IDENTITY_CHANGED', 'Session authorization generation changed', 403);
    }
    // Independently authenticated service callers do not need a browser grant,
    // but every conversation must still belong to the freshly authorized site.
    if (!current && conversationId) {
      const { data, error } = await supabaseAdmin.from('conversations').select('id')
        .eq('id', conversationId).eq('site_id', siteId).maybeSingle();
      if (error || !data) {
        throw new VisitorAuthorizationError('CONVERSATION_FORBIDDEN', 'Conversation is unavailable', 403);
      }
    }
    assertCredentialFresh?.();
    if (request.signal.aborted) throw new Error('Connection closed');
  };
}