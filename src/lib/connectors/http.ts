import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CatalogBodyTooLargeError, readCatalogJson } from '@/lib/services/catalog-search/request-body';
import { requireConnectorSiteAccess } from './access';
import { ConnectorError } from './types';
import { catalogQuerySchema, getConnectorCatalog, getConnectorDetail, siteQuerySchema, toolkitSlugSchema } from './catalog-service';
import { accessPatchSchema, getConnectorAccess, policyPatchSchema, updateConnectorAccess, updateConnectorPolicy } from './management';
import { disconnectConnector, getConnectionSummary, listConnections, revisionBodySchema, syncConnector } from './connection-service';
import { createManagedOAuth } from './managed-oauth';
import { connectSupabaseToken, supabaseTokenInput } from './supabase-token';

const headers = { 'Cache-Control': 'private, no-store' };
const uuid = z.string().uuid();

export async function requireConnectorActor(request: Request): Promise<string> {
  const value = request.headers.get('authorization');
  if (!value || value.length > 8192 || !/^Bearer [A-Za-z0-9._~+\/-]+=*$/i.test(value)) {
    throw new ConnectorError('UNAUTHORIZED', 'Sign in to access connectors.', 401);
  }
  let result;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      supabaseAdmin.auth.getUser(value.slice(7)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Authentication deadline')), 5_000); }),
    ]);
  }
  catch { throw new ConnectorError('AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable.', 503); }
  finally { if (timer) clearTimeout(timer); }
  if (result.error && (!result.error.status || result.error.status >= 500)) {
    throw new ConnectorError('AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable.', 503);
  }
  if (result.error || !uuid.safeParse(result.data.user?.id).success) {
    throw new ConnectorError('UNAUTHORIZED', 'Sign in to access connectors.', 401);
  }
  return result.data.user!.id;
}

export async function requireConnectorRequest(request: Request, siteId: string, manager = false) {
  const userId = await requireConnectorActor(request);
  uuid.parse(siteId);
  const access = await requireConnectorSiteAccess(siteId, userId, manager);
  return { userId, canManage: access.can_manage };
}

export function handleConnectorError(error: unknown): Response {
  if (error instanceof ConnectorError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof CatalogBodyTooLargeError) {
    return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid connector request.' } }, { status: error instanceof CatalogBodyTooLargeError ? 413 : 400, headers });
  }
  return Response.json({ error: { code: 'CONNECTORS_UNAVAILABLE', message: 'Connectors are temporarily unavailable.' } }, { status: 503, headers });
}

export function connectorQuery(request: Request): Record<string, string> {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) {
    throw new ConnectorError('INVALID_REQUEST', 'Duplicate query parameters are not supported.', 400);
  }
  return Object.fromEntries(params);
}

async function body(request: Request): Promise<unknown> {
  if (new URL(request.url).search) throw new ConnectorError('INVALID_REQUEST', 'Mutation parameters belong in the JSON body.', 400);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ConnectorError('JSON_REQUIRED', 'JSON content type required.', 415);
  }
  return readCatalogJson(request, 65_536);
}

type Operation = 'connection-summary' | 'catalog' | 'detail' | 'connections' | 'access' | 'update-access' | 'policy' | 'sync' | 'disconnect' | 'managed-oauth' | 'supabase-token';

/** Every route invocation verifies a bearer actor; middleware/service headers confer no authority. */
export async function connectorHandler(request: Request, operation: Operation, id?: string): Promise<Response> {
  try {
    const userId = await requireConnectorActor(request);
    if (id !== undefined) (operation === 'detail' ? toolkitSlugSchema : uuid).parse(id);
    if (operation === 'catalog') {
      const query = catalogQuerySchema.parse(connectorQuery(request));
      await requireConnectorSiteAccess(query.site_id, userId);
      return Response.json(await getConnectorCatalog(userId, query), { headers });
    }
    if (operation === 'connection-summary') {
      const { site_id } = siteQuerySchema.parse(connectorQuery(request));
      return Response.json(await getConnectionSummary(site_id, userId, uuid.parse(id)), { headers });
    }
    if (['detail', 'connections', 'access'].includes(operation)) {
      const query = siteQuerySchema.parse(connectorQuery(request));
      await requireConnectorSiteAccess(query.site_id, userId);
      const result = operation === 'detail' ? await getConnectorDetail(query.site_id, userId, id!)
        : operation === 'access' ? await getConnectorAccess(query.site_id, userId, id!)
          : await listConnections(query.site_id, userId);
      return Response.json(result, { headers });
    }
    const raw = await body(request);
    if (operation === 'supabase-token') {
      const input = supabaseTokenInput.parse(raw);
      await requireConnectorSiteAccess(input.site_id, userId, true);
      return Response.json(await connectSupabaseToken(input, userId), { headers });
    }
    if (operation === 'managed-oauth') {
      const input = siteQuerySchema.extend({ toolkit_slug: toolkitSlugSchema }).strict().parse(raw);
      return Response.json(await createManagedOAuth(input.site_id, userId, input.toolkit_slug), { headers });
    }
    if (operation === 'update-access') {
      const input = accessPatchSchema.parse(raw);
      await requireConnectorSiteAccess(input.site_id, userId, true);
      return Response.json(await updateConnectorAccess(userId, id!, input), { headers });
    }
    if (operation === 'policy') {
      const input = policyPatchSchema.parse(raw);
      await requireConnectorSiteAccess(input.site_id, userId, true);
      return Response.json(await updateConnectorPolicy(userId, id!, input), { headers });
    }
    const input = revisionBodySchema.parse(raw);
    const connectorId = uuid.parse(id);
    await requireConnectorSiteAccess(input.site_id, userId, true);
    return Response.json(operation === 'disconnect'
      ? await disconnectConnector(input.site_id, userId, connectorId, input.expected_revision)
      : await syncConnector(input.site_id, userId, connectorId, input.expected_revision), { headers });
  } catch (error) { return handleConnectorError(error); }
}