import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { redactRuntimeSecrets } from '@/app/api/cron/shared/runtime-log-context';
import { sourceDigest } from './approval-source';
import type { ApprovalRow, StoredAction } from './approval-action';

// The manager may review this action without unrestricted read access to its original
// conversation. Never use the service client or a shared cache for enrichment.
export function reviewerClient(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const auth = request.headers.get('authorization'); // Already verified by requireConnectorActor.
  if (!url || !key || !auth) return undefined;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: auth }, fetch: (target, options) => fetch(target, { ...options, cache: 'no-store' }) } });
}

function display(value: unknown, limit = 100) {
  if (typeof value !== 'string' || value.length > 32768 || /-----BEGIN [^\n]*PRIVATE KEY-----/i.test(value)) return null;
  const text = redactRuntimeSecrets(value).replace(/\b(?:https?|data):\S+/gi, '[link]')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.length > limit ? `${text.slice(0, limit-1)}…` : text : null;
}
const deadline = () => AbortSignal.timeout(3000);

/** Call only after both manager authorization and live approval origin/action checks. */
export async function reviewContext(db: SupabaseClient | undefined, row: ApprovalRow, action: StoredAction, screens: ToolScreenAccess | null) {
  const instance = action.origin.kind === 'interactive' ? action.origin : null;
  const context = { agent_label: 'Agent', conversation_title: null as string | null,
    instance_id: instance?.instance_id ?? null, instance_label: null as string | null, source_excerpt: null as string | null };
  const visible = (key: string) => screens && (screens.isAdmin || !screens.blockedScreens.includes(key));
  if (!db || !visible('chat') || (instance && !visible('aiWorkspace'))) return context;
  const agent = await db.from('agents').select('name').eq('site_id', row.site_id).eq('id', row.agent_id)
    .abortSignal(deadline()).maybeSingle();
  if (!agent.error) context.agent_label = display(agent.data?.name) ?? context.agent_label;
  const source = action.source;
  if (instance && !row.conversation_id) {
    const origin = await db.from('remote_instances').select('id,name').eq('site_id', row.site_id)
      .eq('id', instance.instance_id).eq('user_id', instance.user_id).abortSignal(deadline()).maybeSingle();
    if (origin.error || origin.data?.id !== instance.instance_id) return context;
    context.instance_label = display(origin.data.name);
    if (source?.kind !== 'instance_log') return context;
    const log = await db.from('instance_logs').select('message').eq('id', source.id).eq('instance_id', instance.instance_id)
      .eq('site_id', row.site_id).eq('user_id', instance.user_id).eq('log_type', 'user_action').eq('trusted_user_action', true)
      .abortSignal(deadline()).maybeSingle();
    if (!log.error && typeof log.data?.message === 'string' && sourceDigest(log.data.message) === source.digest) {
      context.source_excerpt = display(log.data.message, 180);
    }
  } else if (!instance && row.conversation_id) {
    const thread = await db.from('conversations').select('id,title').eq('id', row.conversation_id)
      .eq('site_id', row.site_id).eq('agent_id', row.agent_id).abortSignal(deadline()).maybeSingle();
    if (thread.error || thread.data?.id !== row.conversation_id) return context;
    context.conversation_title = display(thread.data.title);
    if (!source || source.kind === 'instance_log') return context;
    // Messages have no site column. Join to the same live conversation in the content read;
    // a title lookup and a later unjoined message lookup would race tenant reassignment.
    const message = await db.from('messages').select('content,conversations!inner(id)').eq('conversation_id', row.conversation_id)
      .eq('conversations.site_id', row.site_id).eq('conversations.agent_id', row.agent_id).eq('agent_id', row.agent_id)
      .in('role', ['user', 'team_member']).eq(source.kind === 'command' ? 'command_id' : 'id', source.id)
      .limit(2).abortSignal(deadline());
    const content = !message.error && message.data?.length === 1 ? message.data[0].content : null;
    if (typeof content === 'string' && sourceDigest(content) === source.digest) context.source_excerpt = display(content, 180);
  }
  return context;
}
