import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { readCatalogJson, CatalogBodyTooLargeError } from '@/lib/services/catalog-search/request-body';
import { requireConnectorSiteAccess } from './access';
import { ConnectorError } from './types';
import { finishConnectorAuth, getAuthAttempt, startConnectorAuth } from './auth-attempts';

const site = z.string().uuid();
const startSchema = z.object({
  site_id: site, toolkit_slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
  auth_config_id: z.string().regex(/^[a-zA-Z0-9_-]{1,150}$/), nonce: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const completeSchema = z.object({ site_id: site, nonce: startSchema.shape.nonce, session_uri: z.string().min(1).max(4096) }).strict();
const headers = { 'Cache-Control': 'private, no-store' };

async function actor(request: Request, siteId: string) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ') || authorization.length > 8192) throw new ConnectorError('UNAUTHORIZED', 'Sign in to manage connectors.', 401);
  const { data, error } = await supabaseAdmin.auth.getUser(authorization.slice(7));
  if (error || !data.user) throw new ConnectorError('UNAUTHORIZED', 'Sign in to manage connectors.', 401);
  await requireConnectorSiteAccess(siteId, data.user.id, true);
  return data.user.id;
}

export async function connectorAuthHandler(request: Request, operation: 'start' | 'get' | 'complete', id?: string): Promise<Response> {
  try {
    if (id) site.parse(id);
    if (operation === 'get') {
      const params = new URL(request.url).searchParams;
      if (params.getAll('site_id').length !== 1 || [...params.keys()].some(key => key !== 'site_id')) throw new ConnectorError('INVALID_REQUEST', 'A site is required.', 400);
      const siteId = site.parse(params.get('site_id'));
      const userId = await actor(request, siteId);
      const attempt = await getAuthAttempt(siteId, userId, id!);
      return Response.json({ attempt_id: attempt.id, user_id: userId, toolkit_slug: attempt.toolkit_slug, status: attempt.status, expires_at: attempt.expires_at }, { headers });
    }
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new ConnectorError('JSON_REQUIRED', 'JSON content type required.', 415);
    const body = await readCatalogJson(request, 16_384);
    if (operation === 'start') {
      const input = startSchema.parse(body);
      const userId = await actor(request, input.site_id);
      return Response.json(await startConnectorAuth({ siteId: input.site_id, userId, toolkitSlug: input.toolkit_slug, authConfigId: input.auth_config_id, nonce: input.nonce }), { status: 201, headers });
    }
    const input = completeSchema.parse(body);
    const userId = await actor(request, input.site_id);
    return Response.json(await finishConnectorAuth({ siteId: input.site_id, userId, attemptId: id!, nonce: input.nonce, sessionUri: input.session_uri }), { headers });
  } catch (error) {
    if (error instanceof ConnectorError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof CatalogBodyTooLargeError) {
      return Response.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid connector authentication request.' } }, { status: error instanceof CatalogBodyTooLargeError ? 413 : 400, headers });
    }
    return Response.json({ error: { code: 'CONNECTORS_UNAVAILABLE', message: 'Connector authentication is unavailable.' } }, { status: 503, headers });
  }
}