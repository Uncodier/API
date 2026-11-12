import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { connectionDto, mutateConnection } from './management';
import { readConnection } from './store';
import { OpenRouterError } from './types';
import { mutationSchema } from './validation';

export async function requireManager(request: Request, siteId: string): Promise<string> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ') || authorization.length > 10000) throw new OpenRouterError('unauthorized', 'Authentication required', 401);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new OpenRouterError('auth_unavailable', 'Authentication is unavailable');
  // Do not use createSupabaseClient: its legacy x-api-key-data branch is privileged.
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: authorization } } });
  const { data, error } = await client.auth.getUser(authorization.slice(7));
  if (error || !data.user) throw new OpenRouterError('unauthorized', 'Authentication required', 401);
  const role = await client.rpc('current_user_site_role', { p_site_id: siteId });
  if (role.error) throw new OpenRouterError('auth_unavailable', 'Site authorization is unavailable');
  if (role.data !== 'owner' && role.data !== 'admin') throw new OpenRouterError('forbidden', 'Owner or administrator access is required', 403);
  return data.user.id;
}
async function boundedBody(request: Request): Promise<unknown> {
  const max = 32768;
  if (Number(request.headers.get('content-length')) > max) throw new OpenRouterError('invalid_input', 'Request is too large', 413);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new OpenRouterError('invalid_input', 'JSON body required', 415);
  const reader = request.body?.getReader(); if (!reader) throw new OpenRouterError('invalid_input', 'JSON body required', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > max) throw new OpenRouterError('invalid_input', 'Request is too large', 413);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof OpenRouterError) throw error;
    throw new OpenRouterError('invalid_input', 'Invalid JSON body', 400);
  } finally { await reader.cancel().catch(() => undefined); }
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export async function handleOpenRouter(request: Request, action: 'read' | 'models' | 'mutate' | 'setup'): Promise<Response> {
  try {
    if (action === 'mutate') {
      const parsed = mutationSchema.safeParse(await boundedBody(request));
      if (!parsed.success) throw new OpenRouterError('invalid_input', 'Invalid connection configuration', 400);
      const actorId = await requireManager(request, parsed.data.siteId);
      return json(await mutateConnection(actorId, parsed.data));
    }
    const params = new URL(request.url).searchParams;
    if (params.getAll('siteId').length !== 1) throw new OpenRouterError('invalid_input', 'Exactly one siteId is required', 400);
    const query = z.object({ siteId: z.string().uuid() }).strict().safeParse(Object.fromEntries(params));
    if (!query.success) throw new OpenRouterError('invalid_input', 'A valid siteId is required', 400);
    await requireManager(request, query.data.siteId);
    if (action === 'setup') {
      const { setupStatus } = await import('./setup-status');
      return json(await setupStatus(query.data.siteId));
    }
    const row = await readConnection(query.data.siteId);
    return json(action === 'models' ? { models: row?.catalog ?? [], catalogUpdatedAt: row?.catalog_updated_at ?? null } : connectionDto(row));
  } catch (error) {
    if (error instanceof OpenRouterError) return json({ error: error.message, code: error.code }, error.status);
    // Never log or return raw provider, database, request, or credential payloads.
    return json({ error: 'Connection operation is unavailable', code: 'connection_unavailable' }, 503);
  }
}
