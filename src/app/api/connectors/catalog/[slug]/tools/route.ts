import { connectorQuery, handleConnectorError, requireConnectorActor } from '@/lib/connectors/http';
import { getToolkitToolCatalog, toolCatalogQuery } from '@/lib/connectors/tool-catalog';

export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const actor = await requireConnectorActor(request);
    const query = toolCatalogQuery.parse(connectorQuery(request));
    const { slug } = await context.params;
    return Response.json(await getToolkitToolCatalog(actor, slug, query), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return handleConnectorError(error); }
}