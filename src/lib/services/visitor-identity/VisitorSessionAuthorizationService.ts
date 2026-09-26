import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { authorizeVisitorSession } from '@/lib/security/authorize-visitor-session';
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit';

export interface CanonicalVisitorIdentity {
  siteId: string;
  sessionId: string;
  visitorId: string;
  leadId: string | null;
}

export class VisitorAuthorizationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'VisitorAuthorizationError';
    // Preserve instanceof when TypeScript downlevels built-in Error subclasses.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface AuthorizationInput {
  request: Request;
  siteId?: string | null;
  sessionId?: string | null;
  conversationId?: string | null;
}

export class VisitorSessionAuthorizationService {
  async authorizeBrowserRequest(input: AuthorizationInput): Promise<CanonicalVisitorIdentity | null> {
    if (!input.siteId) {
      throw new VisitorAuthorizationError(
        'SESSION_REQUIRED',
        'site_id is required',
        401
      );
    }
    if (!input.sessionId) {
      if (
        hasAuthenticatedPrincipal(input.request)
        && await authorizeVisitorSession(input.request, { siteId: input.siteId })
      ) {
        return null;
      }
      throw new VisitorAuthorizationError(
        'SESSION_REQUIRED',
        'session_id is required',
        401,
      );
    }
    if (!await authorizeVisitorSession(input.request, {
      siteId: input.siteId,
      sessionId: input.sessionId,
    })) {
      throw new VisitorAuthorizationError(
        'SESSION_FORBIDDEN',
        'Visitor session authorization is required',
        403,
      );
    }

    const { data: session, error: sessionError } = await supabaseAdmin
      .from('visitor_sessions')
      .select('id, site_id, visitor_id, lead_id, is_active')
      .eq('id', input.sessionId)
      .eq('site_id', input.siteId)
      .maybeSingle();
    if (sessionError || !session || !session.is_active) {
      throw new VisitorAuthorizationError('INVALID_SESSION', 'Visitor session is invalid or inactive', 401);
    }

    const { data: grant, error: grantError } = await supabaseAdmin
      .from('visitor_session_identity_grants')
      .select('visitor_id, lead_id')
      .eq('site_id', input.siteId)
      .eq('session_id', input.sessionId)
      .eq('visitor_id', session.visitor_id)
      .is('revoked_at', null)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .maybeSingle();
    if (grantError) {
      throw new VisitorAuthorizationError('AUTHORIZATION_UNAVAILABLE', 'Unable to authorize visitor session', 503);
    }
    if (session.lead_id && (!grant || grant.lead_id !== session.lead_id)) {
      throw new VisitorAuthorizationError('IDENTITY_VERIFICATION_REQUIRED', 'An active identity grant is required', 403);
    }

    const identity: CanonicalVisitorIdentity = {
      siteId: input.siteId,
      sessionId: input.sessionId,
      visitorId: session.visitor_id,
      leadId: session.lead_id ? grant?.lead_id || null : null
    };
    if (input.conversationId) {
      await this.assertConversationOwnership(identity, input.conversationId);
    }
    return identity;
  }

  async assertConversationOwnership(
    identity: CanonicalVisitorIdentity,
    conversationId: string
  ): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from('conversations')
      .select('id, site_id, visitor_id, lead_id')
      .eq('id', conversationId)
      .eq('site_id', identity.siteId)
      .maybeSingle();
    if (error) {
      throw new VisitorAuthorizationError('AUTHORIZATION_UNAVAILABLE', 'Unable to authorize conversation', 503);
    }
    const ownedByVisitor = data?.visitor_id === identity.visitorId;
    const ownedByLead = Boolean(identity.leadId && data?.lead_id === identity.leadId);
    if (!data || (!ownedByVisitor && !ownedByLead)) {
      throw new VisitorAuthorizationError('CONVERSATION_FORBIDDEN', 'Conversation does not belong to this session', 403);
    }
  }
}

export const visitorSessionAuthorizationService = new VisitorSessionAuthorizationService();

export function visitorAuthorizationErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof VisitorAuthorizationError)) return null;
  return NextResponse.json(
    { success: false, error: { code: error.code, message: error.message } },
    { status: error.status }
  );
}
