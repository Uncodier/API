import { domainCountsQuerySchema, getConnectorDomainCounts } from '@/lib/connectors/catalog-service';
import { connectorQuery, handleConnectorError, requireConnectorActor } from '@/lib/connectors/http';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const userId = await requireConnectorActor(request);
    const query = domainCountsQuerySchema.parse(connectorQuery(request));
    return Response.json(await getConnectorDomainCounts(userId, query), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return handleConnectorError(error);
  }
}