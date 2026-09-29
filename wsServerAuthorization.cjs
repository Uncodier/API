function isValidUUID(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function denied(code, message) { return { ok: false, code, message }; }

async function authorizeConnection(supabase, params) {
  const { site_id, session_id, conversation_id, claims } = params;
  if (!supabase) {
    return denied('REALTIME_AUTH_UNAVAILABLE', 'Protected realtime is unavailable offline');
  }
  if (![site_id, session_id, conversation_id].every(isValidUUID)) {
    return denied('INVALID_PARAMETERS', 'Valid site, session, and conversation UUIDs are required');
  }
  const validClaims = () => claims && claims.siteId === site_id && claims.sessionId === session_id
    && Number.isFinite(claims.expiresAt) && claims.expiresAt > Date.now();
  if (!validClaims()) return denied('SESSION_FORBIDDEN', 'Visitor session token expired');
  try {
    // Fetch the resource before the live identity/grant checks. A slow
    // conversation read must not outlive the authorization used for a send.
    const { data: conversation, error: conversationError } = await supabase.from('conversations')
      .select('id, site_id, visitor_id, lead_id')
      .eq('id', conversation_id).eq('site_id', site_id).maybeSingle();
    if (conversationError || !conversation) {
      return denied('CONVERSATION_FORBIDDEN', 'Conversation does not belong to this session');
    }
    const { data: session, error: sessionError } = await supabase.from('visitor_sessions')
      .select('id, site_id, visitor_id, lead_id, is_active')
      .eq('id', session_id).eq('site_id', site_id).maybeSingle();
    if (sessionError || !session?.is_active || session.visitor_id !== claims.visitorId) {
      return denied('INVALID_SESSION', 'Visitor session is invalid or inactive');
    }
    const { data: state, error: stateError } = await supabase.from('visitor_identity_session_state')
      .select('epoch').eq('session_id', session_id).maybeSingle();
    if (stateError) return denied('AUTHORIZATION_UNAVAILABLE', 'Unable to authorize session generation');
    const { data: grant, error: grantError } = await supabase.from('visitor_session_identity_grants')
      .select('id, visitor_id, lead_id, granted_at, expires_at')
      .eq('site_id', site_id).eq('session_id', session_id).eq('visitor_id', session.visitor_id)
      .is('revoked_at', null).maybeSingle();
    if (grantError) return denied('AUTHORIZATION_UNAVAILABLE', 'Unable to authorize realtime session');
    const grantValid = () => grant && (!grant.expires_at || Date.parse(grant.expires_at) > Date.now());
    if (session.lead_id && (!grantValid() || grant.lead_id !== session.lead_id)) {
      return denied('IDENTITY_VERIFICATION_REQUIRED', 'An active identity grant is required');
    }
    const leadId = session.lead_id || null;
    const ownedByVisitor = !conversation?.lead_id && conversation?.visitor_id === session.visitor_id;
    const ownedByLead = leadId && conversation?.lead_id === leadId;
    if (conversationError || !conversation || (!ownedByVisitor && !ownedByLead)) {
      return denied('CONVERSATION_FORBIDDEN', 'Conversation does not belong to this session');
    }
    if (!validClaims() || (leadId && !grantValid())) {
      return denied('SESSION_FORBIDDEN', 'Realtime authorization expired');
    }
    return {
      ok: true, visitor_id: session.visitor_id, lead_id: leadId,
      epoch: state?.epoch ?? 0, grant_id: leadId ? grant.id : null,
      granted_at: leadId ? grant.granted_at : null,
    };
  } catch {
    return denied('AUTHORIZATION_UNAVAILABLE', 'Unable to authorize realtime session');
  }
}

module.exports = { authorizeConnection, isValidUUID };