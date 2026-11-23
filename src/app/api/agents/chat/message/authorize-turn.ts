import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const uuid = z.string().uuid();
const input = z.object({ site_id: uuid, conversationId: uuid, message: z.string().trim().min(1).max(20000),
  agentId: uuid.optional(), team_member_id: uuid.optional(), userId: uuid.optional(), lead_id: uuid.nullish(), visitor_id: uuid.nullish(),
  response_format: z.literal('text').optional() });
const failure = (status: number) => Response.json({ success: false, error: { code: 'CHAT_UNAVAILABLE', message: 'Internal chat is unavailable.' } }, { status });

/** Recheck the proxy's assertions under the caller's RLS, not the service role. */
export async function authorizeChatTurn(request: Request, body: unknown) {
  const parsed = input.safeParse(body);
  if (!parsed.success) return failure(400);
  const hints = parsed.data;
  const authorization = request.headers.get('authorization');
  if (request.headers.has('x-api-key') || !authorization?.startsWith('Bearer ')) return failure(401);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return failure(503);
  const db = createClient(url, key, { global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false } });
  const {data: {user}, error: authError} = await db.auth.getUser(authorization.slice(7));
  if (authError || !user || user.role !== 'authenticated' || user.is_anonymous !== false) return failure(401);
  if ([hints.team_member_id, hints.userId].some(id => id && id !== user.id)) return failure(403);
  const {data: allowed, error: permissionError} = await db.rpc('user_can', {p_site_id:hints.site_id,p_command:'insert'});
  if (permissionError || allowed !== true) return failure(permissionError ? 503 : 403);
  const {data: row, error} = await db.from('conversations').select('id,site_id,agent_id,lead_id,visitor_id,channel,custom_data')
    .eq('site_id', hints.site_id).eq('id', hints.conversationId).maybeSingle();
  if (error || !row) return failure(error ? 503 : 404);
  const meta = row.custom_data;
  if (row.site_id !== hints.site_id || row.id !== hints.conversationId || !uuid.safeParse(row.agent_id).success ||
    (meta != null && (typeof meta !== 'object' || Array.isArray(meta))) ||
    ![row.channel, meta?.channel].every(ch => ch == null || ch === 'web') || meta?.channel_delivery || meta?.source || meta?.voice_mode ||
    ((row.lead_id || row.visitor_id) && meta?.is_private !== true) ||
    (hints.agentId && hints.agentId !== row.agent_id) || (hints.lead_id && hints.lead_id !== row.lead_id) ||
    (hints.visitor_id && hints.visitor_id !== row.visitor_id)) return failure(409);
  const agent = await db.from('agents').select('id').eq('site_id', row.site_id).eq('id', row.agent_id).eq('status', 'active').maybeSingle();
  if (agent.error || agent.data?.id !== row.agent_id) return failure(agent.error ? 503 : 409);
  return {conversationId: row.id, site_id: row.site_id, agentId: row.agent_id, team_member_id: user.id,
    lead_id: row.lead_id || undefined, visitor_id: row.visitor_id || undefined, message: hints.message};
}
