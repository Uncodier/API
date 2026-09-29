import { VisitorIdentityError } from '@/lib/services/visitor-identity/contracts';
import { requireIdentitySession } from '@/lib/services/visitor-identity/token-auth';
import { verifyIdentityToken } from '@/lib/services/visitor-identity/token-crypto';
import { ExchangeIdentitySchema, identityRateLimit, identityResponse, readIdentityBody, tokenRouteError } from '@/lib/services/visitor-identity/token-http';
import { exchangeIdentityToken } from '@/lib/services/visitor-identity/token-service';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ session_id: string }> }) {
  try {
    const limited = await identityRateLimit(request, 'exchange');
    if (limited) return limited;
    const body = ExchangeIdentitySchema.parse(await readIdentityBody(request));
    const { session_id } = await context.params;
    const siteQuery = new URL(request.url).searchParams.get('site_id');
    if (session_id !== body.session_id || (siteQuery && siteQuery !== body.site_id)) {
      throw new VisitorIdentityError('invalid_request', 'Session path does not match the request', 400);
    }
    const session = await requireIdentitySession(request, body.site_id, session_id);
    const sessionLimit = await identityRateLimit(request, 'exchange-session', session_id);
    if (sessionLimit) return sessionLimit;
    const claims = verifyIdentityToken(body.identity_token, session);
    return identityResponse(await exchangeIdentityToken(claims, body.identity_token));
  } catch (error) { return tokenRouteError(error); }
}