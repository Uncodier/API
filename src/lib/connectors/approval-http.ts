import { z } from 'zod';
import { CatalogBodyTooLargeError, readCatalogJson } from '@/lib/services/catalog-search/request-body';
import { reviewerClient } from './approval-context';
import { requireConnectorActor, connectorQuery } from './http';
import { ConnectorError } from './types';
import { decideConnectorApproval, listConnectorApprovals } from './approval-decisions';

const uuid = z.string().uuid();
const scope = z.object({ site_id: uuid }).strict();
const headers = { 'Cache-Control': 'private, no-store' };
export async function approvalHandler(request: Request, path?: { id: string; decision: string }) {
  try {
    const userId = await requireConnectorActor(request);
    if (!path) {
      const { site_id } = scope.parse(connectorQuery(request));
      return Response.json(await listConnectorApprovals(site_id, userId, reviewerClient(request)), { headers });
    }
    const id = uuid.parse(path.id);
    const decision = z.enum(['approve', 'reject']).parse(path.decision);
    if (new URL(request.url).search) throw new ConnectorError('INVALID_REQUEST', 'Unexpected query parameters.', 400);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new ConnectorError('JSON_REQUIRED', 'JSON content type required.', 415);
    }
    const { site_id } = scope.parse(await readCatalogJson(request, 1024));
    return Response.json(await decideConnectorApproval(site_id, id, userId, decision), { headers });
  } catch (error) {
    if (error instanceof ConnectorError) return Response.json({ error: error.message }, { status: error.status, headers });
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof CatalogBodyTooLargeError) {
      return Response.json({ error: 'Invalid approval request.' }, { status: error instanceof CatalogBodyTooLargeError ? 413 : 400, headers });
    }
    return Response.json({ error: 'Connector approvals unavailable.' }, { status: 503, headers });
  }
}
