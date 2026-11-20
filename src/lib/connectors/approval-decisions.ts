import { loadToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { requireConnectorSiteAccess, requireConnectorAgent, resolveManagerAction, resolveConnectorAction, loadConnectorCredential } from './access';
import { assertScopes, screenAllowed } from './action-policy';
import { reviewContext, type reviewerClient } from './approval-context';
import { approvalBinding, storedAction, unavailable, type ApprovalRow } from './approval-action';
import { decideRow, finishRow, getApproval, pendingRows } from './approval-store';
import { requireConversationAgent, requireSupportOrigin } from './approval-proposals';
import { assistantConnectorContext } from './host-context';
import { describeConnectorTool, executeConnectorTool, hashConnectorSchema, validateConnectorArguments } from './composio-sessions';
import { canRequestFromConversation, getReviewedTool } from './reviewed-tools';
import { assertReviewedInputLimits, reviewedInputSchema } from './reviewed-tool-schema';
import { validateConnectorInput } from './schema-validation';
import { ConnectorError, type ConnectorContext } from './types';

/** Private service. The approving actor is never inferred from the request's author or site owner. */
async function actionable(row: ApprovalRow, siteId: string, userId: string) {
  if (row.site_id !== siteId || !(Date.parse(row.expires_at) > Date.now())) throw unavailable();
  const parsed = storedAction.safeParse(row.action);
  if (!parsed.success) throw unavailable();
  const action = parsed.data;
  const context: ConnectorContext = { siteId, userId, host: 'assistant', agentId: row.agent_id };
  if (!row.agent_id) throw unavailable();
  const check = async (ctx: ConnectorContext, manager = false) => {
    const access = manager ? await resolveManagerAction(siteId, userId, action.connector_id, action.tool_slug)
      : await resolveConnectorAction(ctx, action.connector_id, action.tool_slug, true);
    if (access.policy.require_approval !== true) throw unavailable();
    const tool = getReviewedTool(action.tool_slug, access.connector.toolkit_slug);
    const screens = await loadToolScreenAccess(ctx);
    if (!screenAllowed(tool, screens)) throw new ConnectorError('ACCESS_DENIED', 'Connector screen access denied.', 403);
    if (approvalBinding(access) !== action.binding) throw unavailable();
    assertScopes(access, tool, action.scopes);
    return { access, tool, screens };
  };
  if (action.origin.kind === 'interactive') {
    if (row.conversation_id !== null) throw unavailable();
    const original = await assistantConnectorContext({ ...context, host: 'assistant', instanceId: action.origin.instance_id, userId: action.origin.user_id })();
    await check(original);
  } else if (action.origin.kind === 'support_member') {
    if (!row.conversation_id || !canRequestFromConversation(action.tool_slug)) throw unavailable();
    await requireSupportOrigin(siteId, row.conversation_id, row.agent_id, action.origin);
    await check({ ...context, userId: action.origin.user_id });
  } else if (action.origin.kind === 'support_publication') {
    const origin = action.origin;
    if (!row.conversation_id || action.tool_slug !== 'GMAIL_FETCH_EMAILS' ||
        (origin.audience === 'verified') !== !!origin.lead_id) throw unavailable();
    await requireSupportOrigin(siteId, row.conversation_id, row.agent_id, origin);
    const { loadSupportPublication } = await import('./support-runtime-publication');
    const { publishedGmailInput } = await import('./support-public-gmail');
    const publication = await loadSupportPublication(siteId, action.connector_id, origin.audience, row.agent_id);
    if (!publication || hashConnectorSchema(publication) !== origin.publication_hash ||
        hashConnectorSchema(action.arguments) !== hashConnectorSchema(publishedGmailInput(publication.labelId))) throw unavailable();
  } else if (action.origin.kind === 'channel_public' || action.origin.kind === 'channel_member') {
    if (!row.conversation_id || !canRequestFromConversation(action.tool_slug)) throw unavailable();
    await requireConversationAgent(siteId, row.conversation_id, row.agent_id, action.origin);
    if (action.origin.kind === 'channel_member') await check({ ...context, userId: action.origin.user_id });
  } else throw unavailable(); // Legacy blind requests cannot prove the original actor.
  const current = await check({ siteId, userId, host: 'assistant' }, true);
  if (action.origin.kind === 'channel_public' || action.origin.kind === 'support_publication') {
    await requireConnectorAgent(current.access.connector, row.agent_id, action.origin.kind === 'channel_public');
  }
  return { ...current, action };
}

export async function listConnectorApprovals(siteId: string, userId: string, db?: ReturnType<typeof reviewerClient>) {
  await requireConnectorSiteAccess(siteId, userId, true);
  const rows = await pendingRows(siteId);
  async function item(row: ApprovalRow) {
    if (row.status !== 'pending') return null;
    try {
      const { action, screens } = await actionable(row, siteId, userId);
      const context = await reviewContext(db, row, action, screens);
      // The destination is not the authorization origin. Instance requests retain
      // their original user/instance binding even when reviewed in Conversations.
      const reviewConversation = row.conversation_id ?? row.connector_approval_review_links?.review_conversation_id;
      if (!reviewConversation) return null;
      return { id: row.id, review_conversation_id: reviewConversation, created_at: row.created_at, context, agent_id: row.agent_id, conversation_id: row.conversation_id,
        connector_id: action.connector_id, account_label: action.account_label, tool_slug: action.tool_slug,
        arguments: action.arguments, version: action.version, expires_at: row.expires_at };
    } catch (error) {
      if (!(error instanceof ConnectorError) || ![403, 404, 409].includes(error.status)) throw error;
      return null;
    }
  }
  // DB caps active pending per site. Never strand a current approval behind a stale one.
  const items = [];
  for (let offset = 0; offset < rows.length; offset += 4) {
    const batch = await Promise.all(rows.slice(offset, offset + 4).map(item));
    for (const entry of batch) if (entry) items.push(entry);
  }
  await requireConnectorSiteAccess(siteId, userId, true);
  return { items };
}

export async function decideConnectorApproval(siteId: string, id: string, userId: string, decision: 'approve' | 'reject') {
  await requireConnectorSiteAccess(siteId, userId, true);
  const pending = await getApproval(siteId, id);
  if (pending.status !== 'pending') throw unavailable();
  await actionable(pending, siteId, userId);
  // Only the winner receives a row. Never retry dispatch after a timeout or crash.
  const row = await decideRow(siteId, id, userId, decision);
  if (decision === 'reject') return { id, status: 'rejected' as const };
  let privateResult: { result: unknown } | { result_omitted: true };
  try {
    const { access, tool, action } = await actionable(row, siteId, userId);
    const credential = await loadConnectorCredential(siteId);
    if (credential.revision !== access.provider.credential_revision) throw unavailable();
    const target = { connector: access.connector, provider: access.provider, credential, toolSlug: tool.slug, toolkitVersion: action.version };
    const descriptor = await describeConnectorTool(target);
    if (descriptor.slug !== tool.slug || descriptor.toolkitSlug !== tool.toolkit || descriptor.toolkitVersion !== action.version ||
      descriptor.schemaHash !== action.schema_hash || descriptor.scopeRequirements !== null) throw unavailable();
    assertScopes(access, tool, descriptor.scopes);
    validateConnectorArguments(action.arguments);
    validateConnectorInput(reviewedInputSchema(tool.slug, descriptor.inputSchema), action.arguments);
    assertReviewedInputLimits(tool.slug, action.arguments);
    const result = await executeConnectorTool({ ...target, input: action.arguments, allowedTools: [tool.slug], schemaHash: action.schema_hash,
      requiredScopes: tool.requiredScopes, beforeDispatch: async () => {
        await requireConnectorSiteAccess(siteId, userId, true);
        await actionable(row, siteId, userId);
        if (!(Date.parse(row.expires_at) > Date.now())) throw unavailable();
      } });
    // Only the winning authenticated manager can receive the already redacted read.
    // No command, audit, conversation or approval row receives provider data.
    let output = result.data;
    if (action.origin.kind === 'support_publication') {
      const { publishedGmailResult } = await import('./support-public-gmail');
      const labels = action.arguments.label_ids;
      if (!Array.isArray(labels) || labels.length !== 1 || typeof labels[0] !== 'string') throw unavailable();
      output = publishedGmailResult(result, labels[0]);
    }
    privateResult = Buffer.byteLength(JSON.stringify(output)) <= 32 * 1024
      ? { result: output } : { result_omitted: true };
  } catch (error) {
    await finishRow(siteId, id, userId, 'failed');
    throw error;
  }
  // A failure to record completion is not permission to send again.
  await finishRow(siteId, id, userId, 'succeeded');
  await requireConnectorSiteAccess(siteId, userId, true);
  await actionable(row, siteId, userId);
  return { id, status: 'completed' as const, ...privateResult };
}
