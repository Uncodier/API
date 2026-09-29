import { authenticateIdentityIssuer, identitySessionEpoch, requireIdentitySession } from '@/lib/services/visitor-identity/token-auth';
import { issueIdentityToken } from '@/lib/services/visitor-identity/token-crypto';
import { identityRateLimit, identityResponse, IssueIdentitySchema, readIdentityBody, tokenRouteError } from '@/lib/services/visitor-identity/token-http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const limited = await identityRateLimit(request, 'issue');
    if (limited) return limited;
    const issuer = await authenticateIdentityIssuer(request);
    const body = IssueIdentitySchema.parse(await readIdentityBody(request));
    const session = await requireIdentitySession(request, issuer.siteId, body.session_id);
    const scopedLimit = await identityRateLimit(request, 'issue-site', issuer.siteId);
    if (scopedLimit) return scopedLimit;
    return identityResponse(issueIdentityToken({
      iss: issuer.issuer, key_id: issuer.keyId, key_fingerprint: issuer.keyFingerprint,
      key_version: issuer.keyVersion,
      sub: body.external_user_id,
      site_id: issuer.siteId, session_id: session.sessionId, visitor_id: session.visitorId,
      epoch: await identitySessionEpoch(session.sessionId), name: body.name, email: body.email,
    }));
  } catch (error) { return tokenRouteError(error); }
}