import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ConnectorError, type AuthorizedConnector, type ConnectorContext } from './types';
import { privateReport } from './private-result-report';

const denied = () => new ConnectorError('ACCESS_DENIED', 'This private destination requires a verified instance owner and current connector use.', 403);
const unavailable = () => new ConnectorError('STORAGE_UNAVAILABLE', 'The private connector result destination is unavailable.', 503);
const unconfirmed = () => new ConnectorError('PRIVATE_DELIVERY_UNCONFIRMED', 'The connector was read, but private delivery could not be confirmed.', 503);
const uuid = z.string().uuid();

export function privateResultBinding(ctx: ConnectorContext, a: AuthorizedConnector, tool: string, catalog: boolean) {
  if (ctx.host !== 'assistant' || ctx.catalogUserSession !== true ||
    [ctx.siteId, ctx.userId, ctx.instanceId, ctx.agentId, a.connector.id].some(v => !uuid.safeParse(v).success)) {
    throw new ConnectorError('PRIVATE_DESTINATION_REQUIRED', 'A verified interactive user and private result destination are required.', 403);
  }
  if (a.requestOnly) throw denied();
  return { p_site_id: ctx.siteId, p_user_id: ctx.userId, p_agent_id: ctx.agentId!, p_instance_id: ctx.instanceId!,
    p_connector_id: a.connector.id, p_connector_revision: a.connector.revision, p_policy_revision: a.policy.revision,
    p_credential_revision: a.provider.credential_revision, p_tool: tool, p_catalog: catalog };
}
type Binding = ReturnType<typeof privateResultBinding>;
export async function checkPrivateDestination(binding: Binding) {
  let response;
  try { response = await supabaseAdmin.rpc('connector_private_result_ready', binding).abortSignal(AbortSignal.timeout(5000)); }
  catch { throw unavailable(); }
  if (response.error || typeof response.data !== 'boolean') throw unavailable();
  if (!response.data) throw denied();
}
export async function deliverPrivateResult(binding: Binding, result: unknown, key: string, version: string, hash: string) {
  const report = privateReport(binding.p_tool, binding.p_catalog, result, key);
  // Neither a DB diagnostic nor the projected report may reach the host. The service
  // role cannot read reports back; only the owner's authenticated RPC can.
  let response;
  try {
    response = await supabaseAdmin.rpc('store_connector_private_result', { ...binding, p_version: version, p_schema_hash: hash, p_report: report }).abortSignal(AbortSignal.timeout(5000));
  } catch { throw unconfirmed(); }
  const { data, error } = response;
  if (error?.code === '42501') throw new ConnectorError('ACCESS_CHANGED', 'Private delivery is no longer authorized.', 403);
  if (error || !uuid.safeParse(data).success) throw unconfirmed();
  return { success: true as const, receipt: { status: 'private_result_ready' as const, url: `/connectors/results/${data}` },
    guidance: 'Give the user this private report link. The model cannot inspect or summarize its rows. Do not fetch the link, guess figures, or copy report contents into chat. The user can also open Connectors → Private reports.' };
}
