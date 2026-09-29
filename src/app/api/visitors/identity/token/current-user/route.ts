import { authenticateFirstPartyUser, identitySessionEpoch, requireIdentitySession } from '@/lib/services/visitor-identity/token-auth';
import { FIRST_PARTY_ISSUER, issueIdentityToken, SUPPORT_SITE_ID } from '@/lib/services/visitor-identity/token-crypto';
import { CurrentUserIdentitySchema, identityRateLimit, identityResponse, readIdentityBody, tokenRouteError } from '@/lib/services/visitor-identity/token-http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const limited = await identityRateLimit(request, 'current-user');
    if (limited) return limited;
    const body = CurrentUserIdentitySchema.parse(await readIdentityBody(request));
    const user = await authenticateFirstPartyUser(request);
    const session = await requireIdentitySession(request, SUPPORT_SITE_ID, body.session_id);
    const userLimit = await identityRateLimit(request, 'current-user-sub', user.id);
    if (userLimit) return userLimit;
    const displayName = user.user_metadata?.name ?? user.user_metadata?.full_name;
    // Neither editable profile email nor user_metadata identifies the subject.
    return identityResponse(issueIdentityToken({
      iss: FIRST_PARTY_ISSUER, sub: user.id,
      site_id: SUPPORT_SITE_ID, session_id: session.sessionId, visitor_id: session.visitorId,
      epoch: await identitySessionEpoch(session.sessionId),
      ...(typeof displayName === 'string' && displayName.trim().length > 0 && displayName.trim().length <= 200
        ? { name: displayName.trim() } : {}),
      ...(user.email_confirmed_at && user.email ? { email: user.email } : {}),
    }));
  } catch (error) { return tokenRouteError(error); }
}