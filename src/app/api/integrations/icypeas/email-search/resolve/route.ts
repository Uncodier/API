import { hasAuthenticatedPrincipal, isInternalServiceRequest } from '@/lib/security/request-rate-limit';
import { canAccessSite } from '@/lib/security/site-access';
import { EmailSearchError, resolveDurableEmailSearch, resolveEmailInput } from '@/lib/integrations/icypeas/durable-email-search';

export const runtime = 'nodejs';

function fail(status: number, code: string, message: string) {
  return Response.json({ success: false, error: { code, message } }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: Request) {
  // Private route: middleware strips client principal headers and installs only
  // authenticated key metadata or validated JWT user metadata. A site/user ID
  // supplied in the body or an unvalidated x-auth-user-id is never sufficient.
  if (!hasAuthenticatedPrincipal(request)) return fail(401, 'UNAUTHORIZED', 'Authentication is required');
  let body: unknown;
  try { body = await request.json(); }
  catch { return fail(400, 'INVALID_INPUT', 'A JSON request body is required'); }
  const input = resolveEmailInput.safeParse(body);
  if (!input.success) return fail(400, 'INVALID_INPUT', 'Expected site_id UUID, domainOrCompany and at least one name; no search IDs or extra fields');
  try {
    if (!isInternalServiceRequest(request) && !await canAccessSite(request, input.data.site_id)) {
      return fail(403, 'FORBIDDEN', 'Access to this site is required');
    }
    const data = await resolveDurableEmailSearch(input.data);
    return Response.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof EmailSearchError) return fail(error.httpStatus, error.code, error.message);
    return fail(503, 'RESOLVER_UNAVAILABLE', 'IcyPeas resolution is unavailable');
  }
}