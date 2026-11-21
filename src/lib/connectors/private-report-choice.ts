import { z } from 'zod';
import { reviewerClient } from './approval-context';
import { requireConnectorActor } from './http';
import { reportViewId, SUPABASE_CATALOG_SLUG } from './supabase-report-contract';
import { assistantConnectorContext } from './host-context';
import { connectorToolRef } from './reviewed-tools';
import { createConnectorRuntime } from './runtime';
import { ConnectorError } from './types';
import { readCatalogJson, CatalogBodyTooLargeError } from '@/lib/services/catalog-search/request-body';

const uuid = z.string().uuid();
const view = z.string().refine(reportViewId);
const pick = z.object({ choice: z.number().int().min(-1).max(24) }).strict();
const origin = z.object({ site_id: uuid, user_id: uuid, agent_id: uuid, instance_id: uuid, connector_id: uuid,
  version: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/), schema_hash: z.string().regex(/^[a-f0-9]{64}$/),
  arguments: z.union([z.object({ view }).strict(), z.object({ after: view }).strict()]) }).strict();
const headers = { 'Cache-Control': 'private, no-store' };
const failure = (status: number) => Response.json({ error: 'Private report could not be opened.' }, { status, headers });

export async function openPrivateReport(request: Request, id: string) {
  try {
    const userId = await requireConnectorActor(request);
    if (!uuid.safeParse(id).success || new URL(request.url).search) return failure(400);
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return failure(415);
    const { choice } = pick.parse(await readCatalogJson(request, 128));
    // Only the actual user JWT can call this RPC. Read neither through admin nor
    // from client-provided context. Its database predicate excludes anonymous users.
    const db = reviewerClient(request);
    if (!db) return failure(503);
    const choiceForOwner = async () => {
      const { data, error } = await db.rpc('connector_private_report_choice', { p_id: id, p_choice: choice }).abortSignal(AbortSignal.timeout(5000));
      if (error) throw new ConnectorError('STORAGE_UNAVAILABLE', 'Private destination unavailable.', 503);
      const row = origin.safeParse(data);
      if (!row.success || row.data.user_id !== userId) throw new ConnectorError('NOT_FOUND', 'Private report unavailable.', 404);
      return row.data;
    };
    const row = await choiceForOwner();
    // Every runtime authorization (including beforeDispatch and postflight) rechecks
    // that the original report still admits the same owner and exact selection.
    const context = assistantConnectorContext({ host: 'assistant', siteId: row.site_id, userId, agentId: row.agent_id,
      instanceId: row.instance_id, connectorIdHint: row.connector_id, catalogUserSession: true });
    const runtime = createConnectorRuntime(async () => {
      if (JSON.stringify(await choiceForOwner()) !== JSON.stringify(row)) throw new ConnectorError('ACCESS_CHANGED', 'Private report is no longer available.', 403);
      return context();
    });
    const receipt = await runtime.call(connectorToolRef(row.connector_id, SUPABASE_CATALOG_SLUG), {
      version: row.version, schema_hash: row.schema_hash, arguments: row.arguments });
    if (!('receipt' in receipt) || !receipt.receipt || receipt.receipt.status !== 'private_result_ready' || !('url' in receipt.receipt)) return failure(503);
    // Never forward a generic runtime envelope from this HTTP boundary.
    const match = /^\/connectors\/results\/([^/]+)$/.exec(String(receipt.receipt.url));
    if (!match || !uuid.safeParse(match[1]).success) return failure(503);
    return Response.json({ id: match[1] }, { headers });
  } catch (error) {
    if (error instanceof ConnectorError) return failure(error.status);
    if (error instanceof CatalogBodyTooLargeError) return failure(413);
    return failure(error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503);
  }
}
