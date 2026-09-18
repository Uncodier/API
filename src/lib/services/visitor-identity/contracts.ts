export type IdentityStatus = 'verification_required' | 'verified' | 'new_lead';

export interface IdentityChallengeResponse {
  identity_status: 'verification_required';
  challenge_id: string;
  masked_email: string;
  expires_at: string;
  resend_available_at: string;
}

export interface VerifiedIdentityResponse {
  identity_status: 'verified' | 'new_lead';
  lead_id: string;
  is_new_lead?: boolean;
}

export type IdentifyResult = IdentityChallengeResponse | VerifiedIdentityResponse;

export interface IdentityContext {
  challengeId: string;
  siteId: string;
  sessionId: string;
  visitorId: string;
  leadId: string;
  normalizedEmail: string;
}

export class VisitorIdentityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = 'VisitorIdentityError';
    Object.setPrototypeOf(this, VisitorIdentityError.prototype);
  }
}

export function identityErrorBody(error: unknown): {
  success: false;
  error: { code: string; message: string; retry_after?: number };
} {
  const identityError = error instanceof VisitorIdentityError
    ? error
    : new VisitorIdentityError('internal_error', 'Unable to process identity request', 500);
  return {
    success: false,
    error: {
      code: identityError.code,
      message: identityError.message,
      ...(identityError.retryAfter ? { retry_after: identityError.retryAfter } : {})
    }
  };
}

export function normalizeIdentityEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function maskIdentityEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}
