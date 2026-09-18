import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { manageLeadCreation } from '@/lib/services/leads/lead-service';
import {
  type IdentifyResult,
  type IdentityChallengeResponse,
  type IdentityContext,
  VisitorIdentityError,
  maskIdentityEmail,
  normalizeIdentityEmail
} from './contracts';
import { visitorIdentityEmailService } from './email-service';
import { generateOtpCode, hashIdentityRateLimitValue, hashOtp } from './otp-crypto';

interface IdentifyInput {
  siteId: string;
  sessionId: string;
  visitorId?: string;
  leadId?: string;
  name?: string;
  email: string;
  phone?: string;
  requestIp?: string;
}

type RpcResult = Record<string, unknown>;

function rpcData(data: unknown, error: { message?: string } | null): RpcResult {
  if (error) throw new VisitorIdentityError('identity_storage_error', 'Identity verification is unavailable', 503);
  if (!data || typeof data !== 'object') {
    throw new VisitorIdentityError('identity_storage_error', 'Identity verification returned an invalid result', 503);
  }
  return data as RpcResult;
}

function challengeResponse(result: RpcResult): IdentityChallengeResponse {
  return {
    identity_status: 'verification_required',
    challenge_id: String(result.challenge_id),
    masked_email: String(result.masked_email),
    expires_at: String(result.expires_at),
    resend_available_at: String(result.resend_available_at)
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export class VisitorIdentityService {
  private async loadSession(siteId: string, sessionId: string, visitorId?: string) {
    const { data, error } = await supabaseAdmin
      .from('visitor_sessions')
      .select('id, site_id, visitor_id, lead_id, is_active')
      .eq('id', sessionId)
      .eq('site_id', siteId)
      .maybeSingle();
    if (error || !data || (visitorId && data.visitor_id !== visitorId)) {
      throw new VisitorIdentityError('invalid_session', 'Visitor session was not found', 404);
    }
    return data as { id: string; site_id: string; visitor_id: string; lead_id: string | null; is_active: boolean };
  }

  private async findLead(siteId: string, normalizedEmail: string, leadId?: string) {
    let query = supabaseAdmin.from('leads').select('id, email').eq('site_id', siteId);
    query = leadId
      ? query.eq('id', leadId)
      : query.ilike('email', escapeLike(normalizedEmail));
    const { data, error } = await query.order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (error) throw new VisitorIdentityError('identity_storage_error', 'Unable to resolve identity', 503);
    if (leadId && (!data || normalizeIdentityEmail(data.email || '') !== normalizedEmail)) {
      throw new VisitorIdentityError('lead_mismatch', 'Lead does not match this site and email', 400);
    }
    return data as { id: string; email: string } | null;
  }

  private async hasActiveGrant(siteId: string, sessionId: string, visitorId: string, leadId: string) {
    const { data, error } = await supabaseAdmin
      .from('visitor_session_identity_grants')
      .select('lead_id')
      .eq('site_id', siteId)
      .eq('session_id', sessionId)
      .eq('visitor_id', visitorId)
      .eq('lead_id', leadId)
      .is('revoked_at', null)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .maybeSingle();
    if (error) throw new VisitorIdentityError('identity_storage_error', 'Unable to resolve identity grant', 503);
    return Boolean(data);
  }

  private async issueChallenge(params: {
    siteId: string;
    sessionId: string;
    visitorId: string;
    leadId: string;
    email: string;
    requestIp?: string;
  }): Promise<IdentityChallengeResponse> {
    const challengeId = randomUUID();
    const code = generateOtpCode();
    const context: IdentityContext = {
      challengeId,
      siteId: params.siteId,
      sessionId: params.sessionId,
      visitorId: params.visitorId,
      leadId: params.leadId,
      normalizedEmail: params.email
    };
    const { data, error } = await supabaseAdmin.rpc('issue_visitor_identity_challenge', {
      p_challenge_id: challengeId,
      p_site_id: params.siteId,
      p_session_id: params.sessionId,
      p_visitor_id: params.visitorId,
      p_lead_id: params.leadId,
      p_normalized_email: params.email,
      p_masked_email: maskIdentityEmail(params.email),
      p_otp_hash: hashOtp(code, context),
      p_request_ip_hash: params.requestIp ? hashIdentityRateLimitValue(params.requestIp) : null
    });
    const result = rpcData(data, error);
    if (result.status === 'rate_limited') {
      throw new VisitorIdentityError('rate_limited', 'Too many verification requests', 429, Number(result.retry_after));
    }
    if (result.status !== 'issued') {
      throw new VisitorIdentityError('invalid_session', 'Visitor session was not found', 404);
    }
    try {
      await visitorIdentityEmailService.sendCode({
        siteId: params.siteId,
        leadId: params.leadId,
        email: params.email,
        code
      });
    } catch (error) {
      await supabaseAdmin.rpc('cancel_visitor_identity_challenge', {
        p_challenge_id: challengeId,
        p_site_id: params.siteId,
        p_session_id: params.sessionId
      });
      throw error;
    }
    return challengeResponse(result);
  }

  async identify(input: IdentifyInput): Promise<IdentifyResult> {
    const normalizedEmail = normalizeIdentityEmail(input.email);
    const session = await this.loadSession(input.siteId, input.sessionId, input.visitorId);
    let lead = await this.findLead(input.siteId, normalizedEmail, input.leadId);

    if (lead && await this.hasActiveGrant(input.siteId, input.sessionId, session.visitor_id, lead.id)) {
      return { identity_status: 'verified', lead_id: lead.id };
    }
    if (lead) {
      return this.issueChallenge({
        siteId: input.siteId,
        sessionId: input.sessionId,
        visitorId: session.visitor_id,
        leadId: lead.id,
        email: normalizedEmail,
        requestIp: input.requestIp
      });
    }

    const created = await manageLeadCreation({
      name: input.name?.trim() || normalizedEmail.split('@')[0],
      email: normalizedEmail,
      siteId: input.siteId,
      visitorId: session.visitor_id,
      origin: 'website_session',
      createTask: false
    });
    if (!created.leadId) {
      throw new VisitorIdentityError('lead_creation_failed', 'Unable to create lead', 500);
    }
    if (created.isNewLead && input.phone) {
      await supabaseAdmin.from('leads').update({ phone: input.phone }).eq('id', created.leadId).eq('site_id', input.siteId);
    }

    const { data, error } = await supabaseAdmin.rpc('grant_new_visitor_identity', {
      p_site_id: input.siteId,
      p_session_id: input.sessionId,
      p_visitor_id: session.visitor_id,
      p_lead_id: created.leadId,
      p_normalized_email: normalizedEmail,
      p_trusted_token_hash: null
    });
    const grant = rpcData(data, error);
    if (created.isNewLead && grant.status === 'granted') {
      return { identity_status: 'new_lead', lead_id: created.leadId, is_new_lead: true };
    }

    const existingLeadId = typeof grant.lead_id === 'string' ? grant.lead_id : created.leadId;
    lead = await this.findLead(input.siteId, normalizedEmail, existingLeadId);
    if (!lead) throw new VisitorIdentityError('identity_conflict', 'Unable to resolve concurrent identity', 409);
    return this.issueChallenge({
      siteId: input.siteId,
      sessionId: input.sessionId,
      visitorId: session.visitor_id,
      leadId: lead.id,
      email: normalizedEmail,
      requestIp: input.requestIp
    });
  }

  async verify(params: { siteId: string; sessionId: string; challengeId: string; code: string }) {
    const challenge = await this.loadChallenge(params);
    const candidateHash = hashOtp(params.code, challenge.context);
    const { data, error } = await supabaseAdmin.rpc('verify_consume_visitor_identity_challenge', {
      p_challenge_id: params.challengeId,
      p_site_id: params.siteId,
      p_session_id: params.sessionId,
      p_otp_hash: candidateHash,
      p_trusted_token_hash: null
    });
    const result = rpcData(data, error);
    if (result.status === 'verified' && typeof result.lead_id === 'string') {
      return { identity_status: 'verified' as const, lead_id: result.lead_id };
    }
    if (result.status === 'invalid_code') {
      throw new VisitorIdentityError('invalid_code', 'Verification code is invalid', 400);
    }
    if (result.status === 'attempt_limit') {
      throw new VisitorIdentityError('attempt_limit', 'Too many invalid verification attempts', 429);
    }
    throw new VisitorIdentityError('challenge_expired', 'Verification challenge is expired or unavailable', 410);
  }

  async resend(params: { siteId: string; sessionId: string; challengeId: string }) {
    const challenge = await this.loadChallenge(params);
    const code = generateOtpCode();
    const { data, error } = await supabaseAdmin.rpc('resend_visitor_identity_challenge', {
      p_challenge_id: params.challengeId,
      p_site_id: params.siteId,
      p_session_id: params.sessionId,
      p_otp_hash: hashOtp(code, challenge.context)
    });
    const result = rpcData(data, error);
    if (result.status === 'cooldown') {
      throw new VisitorIdentityError('resend_cooldown', 'Verification code cannot be resent yet', 429, Number(result.retry_after));
    }
    if (result.status === 'resend_limit') {
      throw new VisitorIdentityError('resend_limit', 'Verification code resend limit reached', 429);
    }
    if (result.status !== 'resent') {
      throw new VisitorIdentityError('challenge_expired', 'Verification challenge is expired or unavailable', 410);
    }
    try {
      await visitorIdentityEmailService.sendCode({
        siteId: params.siteId,
        leadId: challenge.context.leadId,
        email: challenge.context.normalizedEmail,
        code
      });
    } catch (error) {
      await this.cancel(params);
      throw error;
    }
    return challengeResponse({ ...result, challenge_id: params.challengeId, masked_email: challenge.maskedEmail });
  }

  async cancel(params: { siteId: string; sessionId: string; challengeId: string }) {
    const { error } = await supabaseAdmin.rpc('cancel_visitor_identity_challenge', {
      p_challenge_id: params.challengeId,
      p_site_id: params.siteId,
      p_session_id: params.sessionId
    });
    if (error) throw new VisitorIdentityError('identity_storage_error', 'Unable to cancel verification', 503);
  }

  async revoke(params: { siteId: string; sessionId: string }) {
    const { error } = await supabaseAdmin.rpc('revoke_visitor_session_identity', {
      p_site_id: params.siteId,
      p_session_id: params.sessionId
    });
    if (error) throw new VisitorIdentityError('identity_storage_error', 'Unable to revoke identity', 503);
  }

  private async loadChallenge(params: { siteId: string; sessionId: string; challengeId: string }) {
    const { data, error } = await supabaseAdmin
      .from('visitor_identity_challenges')
      .select('id, site_id, session_id, visitor_id, lead_id, normalized_email, masked_email')
      .eq('id', params.challengeId)
      .eq('site_id', params.siteId)
      .eq('session_id', params.sessionId)
      .maybeSingle();
    if (error || !data) {
      throw new VisitorIdentityError('challenge_not_found', 'Verification challenge was not found', 404);
    }
    return {
      maskedEmail: data.masked_email as string,
      context: {
        challengeId: data.id,
        siteId: data.site_id,
        sessionId: data.session_id,
        visitorId: data.visitor_id,
        leadId: data.lead_id,
        normalizedEmail: data.normalized_email
      } satisfies IdentityContext
    };
  }
}

export const visitorIdentityService = new VisitorIdentityService();
