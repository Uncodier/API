import { z } from 'zod';
import { authorizeCatalogRequest, CatalogAuthorizationError } from '@/lib/services/catalog-search/auth';
import { catalogSearchSchema } from '@/lib/services/catalog-search/contract';
import { searchCatalog, CatalogSearchChangedError } from '@/lib/services/catalog-search/service';
import { enforceRequestRateLimit } from '@/lib/security/request-rate-limit';
import { CatalogBodyTooLargeError, readCatalogJson } from '@/lib/services/catalog-search/request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const input = catalogSearchSchema.parse(await readCatalogJson(request, 8_192));
    const principal = await authorizeCatalogRequest(request, input);
    const denied = await enforceRequestRateLimit(request, {
      namespace: 'catalog-search', identity: principal.rateIdentity || principal.scope,
      limit: principal.aggregateOnly ? 600 : 180, windowSeconds: 60, failClosed: true,
    });
    if (denied) return denied;
    return Response.json(await searchCatalog(input, principal), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof CatalogAuthorizationError ? error.status
      : error instanceof CatalogBodyTooLargeError ? 413
      : error instanceof CatalogSearchChangedError ? 409
      : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503;
    return Response.json({ success: false, error: { code: status === 503 ? 'CATALOG_SEARCH_UNAVAILABLE'
      : status === 409 ? 'CATALOG_SEARCH_CHANGED' : 'CATALOG_SEARCH_REJECTED',
      message: status === 503 ? 'Catalog search is temporarily unavailable' : 'Invalid or unauthorized catalog search' } },
    { status, headers: { 'Cache-Control': 'no-store' } });
  }
}