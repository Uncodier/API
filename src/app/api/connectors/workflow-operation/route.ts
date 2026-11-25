import { handleConnectorError, requireConnectorRequest } from '@/lib/connectors/http';
import { describeWorkflowOperation, operationRequest } from '@/lib/connectors/workflow-read-descriptor';
import { ConnectorError } from '@/lib/connectors/types';
import { readCatalogJson } from '@/lib/services/catalog-search/request-body';

import { validateJson } from '@/lib/connectors/composio-transport';

export const runtime = 'nodejs';
export async function POST(request:Request) {
  try {
    if (new URL(request.url).search) throw new ConnectorError('INVALID_REQUEST','Use the JSON request body.',400);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json') {
      throw new ConnectorError('JSON_REQUIRED','JSON content type required.',415);
    }
    const raw=await readCatalogJson(request,48_000);
    validateJson(raw); // Reject unsafe keys before any object parser can discard them.
    const body=operationRequest.parse(raw);
    const {userId}=await requireConnectorRequest(request,body.site_id,true);
    return Response.json(await describeWorkflowOperation(userId,body),{headers:{'Cache-Control':'private, no-store'}});
  } catch (error) { return handleConnectorError(error); }
}
