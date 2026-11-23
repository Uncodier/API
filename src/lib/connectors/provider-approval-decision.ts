import 'server-only';
import { loadConnectorCredential, requireConnectorSiteAccess } from './access';
import { unavailable, type ApprovalRow, type StoredAction } from './approval-action';
import { requireConversationAgent } from './approval-proposals';
import { hashConnectorSchema } from './composio-tool-json';
import { genericReviewTarget, reviewSlug } from './generic-review-target';
import { describeDirectTool, executeDirectTool } from './provider-direct-transport';
import { assertDirectArguments } from './provider-direct-validation';
import { ConnectorError } from './types';

/** Only new channel proposals carry this discriminator. Approval claims authorize a
 * single pinned dispatch, never a durable grant or a result in the originating chat. */
export async function providerApproval(row: ApprovalRow, action: StoredAction, siteId: string, reviewer: string) {
  const { origin, connector_id: account, tool_slug: slug } = action;
  const conversation = row.conversation_id;
  if (action.execution !== 'provider' || row.site_id !== siteId || !row.agent_id || !conversation || !reviewSlug.safeParse(slug).success || action.scopes.length ||
      (origin.kind !== 'channel_member' && origin.kind !== 'channel_public')) throw unavailable();

  const authorize = async () => {
    if (!(Date.parse(row.expires_at) > Date.now())) throw unavailable();
    await requireConnectorSiteAccess(siteId, reviewer, true);
    await requireConversationAgent(siteId, conversation, row.agent_id, origin);
    const check = async (actor: string, role:'reviewer'|'requester'='reviewer') => {
      const { target, screens } = await genericReviewTarget(siteId, row.agent_id, account, slug, actor, role);
      if (!screens || target.requestOnly || target.policy.require_approval !== true || target.connector.id !== account ||
          target.connector.site_id !== siteId || target.connector.display_name !== action.account_label ||
          hashConnectorSchema(target) !== action.binding) throw unavailable();
      return { target, screens };
    };
    if (origin.kind === 'channel_member' && origin.user_id !== reviewer) await check(origin.user_id,'requester');
    const manager = await check(reviewer);
    if (!(Date.parse(row.expires_at) > Date.now())) throw unavailable();
    return manager;
  };

  const { target } = await authorize();
  const credential = await loadConnectorCredential(siteId);
  if (credential.revision !== target.provider.credential_revision) throw unavailable();
  try {
    const d = await describeDirectTool(target, credential, slug, action.version);
    if (action.version !== d.version || action.schema_hash !== d.schemaHash) throw unavailable();
    assertDirectArguments(d.parameters, action.arguments);
  } catch (error) {
    // A malformed/stale stored pin or argument cannot invalidate the entire review queue.
    if (error instanceof ConnectorError && error.status === 400) throw unavailable();
    throw error;
  }
  const { screens } = await authorize();
  return { mode: 'provider' as const, action, screens, execute: async () => {
    await executeDirectTool(target, credential, slug, { version: action.version, schema_hash: action.schema_hash,
      arguments: action.arguments }, async () => { await authorize(); });
    // Direct responses may contain arbitrary private provider data. Discard rather than
    // projecting them into this API (or persisting them for the public requester).
    return { result_omitted: true as const };
  } };
}
