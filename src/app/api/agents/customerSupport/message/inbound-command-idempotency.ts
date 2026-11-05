import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export type InboundCommandKey = { siteId: string; connectionId: string; originMessageId: string };
type Claim = { state: 'claimed'; token: string } | { state: 'reuse'; commandId: string } | { state: 'busy' };
const table = () => supabaseAdmin
  .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
  .from('customer_support_inbound_commands');
const scope = (query: any, key: InboundCommandKey) => query.eq('site_id', key.siteId)
  .eq('connection_id', key.connectionId).eq('origin_message_id', key.originMessageId);

/** No lease/reclaim: a crash after submission must never authorize a second command. */
export async function claimInboundCommand(key: InboundCommandKey): Promise<Claim> {
  if (!key.siteId || !key.connectionId || !key.originMessageId) throw new Error('Incomplete inbound identity');
  const token = randomUUID();
  const { error } = await table().insert({ site_id: key.siteId, connection_id: key.connectionId,
    origin_message_id: key.originMessageId, owner_token: token });
  if (!error) return { state: 'claimed', token };
  if (error.code !== '23505') throw new Error('Inbound command claim unavailable');
  const existing = await scope(table().select('command_id'), key).single();
  if (existing.error || !existing.data) throw new Error('Inbound command receipt unavailable');
  return existing.data.command_id ? { state: 'reuse', commandId: existing.data.command_id } : { state: 'busy' };
}

export async function bindInboundCommand(key: InboundCommandKey, token: string, commandId: string): Promise<void> {
  const { data, error } = await scope(table().update({ command_id: commandId }), key)
    .eq('owner_token', token).is('command_id', null).select('command_id').single();
  if (error || data?.command_id !== commandId) throw new Error('Inbound command binding unavailable');
}