import { hasAuthenticatedPrincipal } from './request-rate-limit';
import { canAccessSite } from './site-access';
import {
  verifyVisitorSessionToken,
  visitorSessionTokenFromRequest,
} from './visitor-session-token';

export async function authorizeVisitorSession(
  request: Request,
  input: {
    siteId: string;
    sessionId?: string;
    visitorId?: string;
  },
): Promise<boolean> {
  if (hasAuthenticatedPrincipal(request)) {
    return canAccessSite(request, input.siteId);
  }
  return verifyVisitorSessionToken(
    visitorSessionTokenFromRequest(request),
    input,
  );
}
