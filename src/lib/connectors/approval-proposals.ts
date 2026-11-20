import { z } from 'zod';
import { approvalSource } from './approval-source';
import { isPrivateSupportThread } from './support-thread';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError, loadConnectorCredential, resolveConnectorAction, requireConnectorAgent, resolveConnectorPolicy } from './access';
import { actionSnapshot, unavailable, type Descriptor, type StoredAction } from './approval-action';
import { requestProposal, type ProposalScope } from './approval-store';
import { describeConnectorTool, hashConnectorSchema, validateConnectorArguments } from './composio-sessions';
import { canRequestFromConversation, getReviewedTool, policyReviewedTools } from './reviewed-tools';
import { assertReviewedInputLimits, reviewedInputSchema } from './reviewed-tool-schema';
import { validateConnectorInput } from './schema-validation';
import { loadToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { assertScopes, screenAllowed } from './action-policy';
import { CONNECTOR_COLUMNS, ConnectorError, type Connector, type ConnectorContext, type AuthorizedConnector } from './types';

const uuid = z.string().uuid();
const scopeSchema = z.object({ siteId: uuid, conversationId: uuid, agentId: uuid, idempotencyKey: z.string().min(1).max(256), source: approvalSource.optional() }).strict();
const proposal = z.object({ tool_slug: z.string().max(128), arguments: z.record(z.unknown()) }).strict();
const signal = () => AbortSignal.timeout(5000);

export async function requireConversationAgent(siteId: string, conversationId: string, agentId: string, origin: Extract<StoredAction['origin'], {kind: 'channel_member' | 'channel_public'}>) {
  if (origin.kind === 'channel_public') {
    await requireActiveSupportAgent(siteId, agentId);
  }
  let query = supabaseAdmin.from('conversations').select('id,lead_id,visitor_id,channel,custom_data').eq('site_id', siteId)
    .eq('id', conversationId).eq('agent_id', agentId);
  if (origin.kind === 'channel_member') query = query.eq('user_id', origin.user_id);
  if (origin.kind === 'channel_public' && origin.lead_id) query = query.eq('lead_id', origin.lead_id);
  const { data, error } = await query.abortSignal(signal()).maybeSingle();
  if (error) connectorDatabaseError(error);
  if (!data || data.channel === 'internal_review' || (origin.kind === 'channel_member' && !isPrivateSupportThread(data))) throw unavailable();
}

type SupportOrigin = Extract<StoredAction['origin'], { kind: 'support_member' | 'support_publication' }>;

async function requireActiveSupportAgent(siteId: string, agentId: string) {
  const agent = await supabaseAdmin.from('agents').select('id').eq('site_id', siteId).eq('id', agentId)
    .eq('role', 'Customer Support').eq('status', 'active').abortSignal(signal()).maybeSingle();
  if (agent.error) connectorDatabaseError(agent.error);
  if (!agent.data) throw unavailable();
}

/** Public threads can retain the agent owner's user_id. Recheck the support
 * role and private member-thread evidence used to admit the original host. */
export async function requireSupportOrigin(siteId: string, conversationId: string, agentId: string, origin: SupportOrigin) {
  await requireActiveSupportAgent(siteId, agentId);
  let query = supabaseAdmin.from('conversations').select('id,lead_id,visitor_id,channel,custom_data')
    .eq('site_id', siteId).eq('id', conversationId).eq('agent_id', agentId);
  if (origin.kind === 'support_member') query = query.eq('user_id', origin.user_id);
  else if (origin.lead_id) query = query.eq('lead_id', origin.lead_id);
  const { data, error } = await query.abortSignal(signal()).maybeSingle();
  if (error) connectorDatabaseError(error);
  if (!data || data.channel === 'internal_review') throw unavailable();
  if (origin.kind === 'support_member' && !isPrivateSupportThread(data)) throw unavailable();
}

/** The gateway has just reauthorized this exact account and pinned descriptor. No slug-only account selection. */
export async function proposeExactSupportAction(scope: ProposalScope, origin: SupportOrigin,
  access: AuthorizedConnector, descriptor: Descriptor, args: Record<string, unknown>) {
  const trusted = scopeSchema.parse(scope);
  if (!canRequestFromConversation(descriptor.slug) || trusted.siteId !== access.connector.site_id || access.policy.require_approval !== true ||
      descriptor.toolkitSlug !== access.connector.toolkit_slug) throw unavailable();
  validateConnectorArguments(args);
  return requestProposal(trusted, actionSnapshot(origin, access, descriptor, args));
}

/** No customer identity is a member, no account fallback, and no execution branch. */
export async function proposeConversationConnectorAction(scope: ProposalScope & { conversationId: string; memberUserId?: string; leadId?: string }, input: unknown) {
  const { memberUserId, leadId, ...binding } = scope;
  const trusted = scopeSchema.parse(binding);
  const origin = memberUserId !== undefined ? { kind: 'channel_member' as const, user_id: uuid.parse(memberUserId) }
    : { kind: 'channel_public' as const, lead_id: leadId === undefined ? null : uuid.parse(leadId) };
  const { tool_slug, arguments: args } = proposal.parse(input);
  validateConnectorArguments(args);
  const tool = getReviewedTool(tool_slug);
  if (!canRequestFromConversation(tool.slug)) throw unavailable();
  await requireConversationAgent(trusted.siteId, trusted.conversationId, trusted.agentId, origin);
  const context = memberUserId ? { siteId: trusted.siteId, userId: memberUserId, host: 'assistant' as const, agentId: trusted.agentId } : null;
  if (context && !screenAllowed(tool, await loadToolScreenAccess(context))) throw unavailable();
  const { data, error } = await supabaseAdmin.from('connectors').select(CONNECTOR_COLUMNS).eq('site_id', trusted.siteId)
    .eq('toolkit_slug', tool.toolkit).eq('enabled', true).eq('provider_status', 'ACTIVE')
    .eq('revocation_pending', false).limit(11).abortSignal(signal());
  if (error || !data) connectorDatabaseError(error);
  if (data.length > 10) throw unavailable();
  let selected: AuthorizedConnector | undefined;
  for (const connector of data as Connector[]) {
    let candidate: AuthorizedConnector;
    try {
      if (context) candidate = await resolveConnectorAction(context, connector.id, tool.slug, true);
      else {
        await requireConnectorAgent(connector, trusted.agentId, true);
        candidate = await resolveConnectorPolicy(connector, 'assistant');
      }
      if (candidate.policy.require_approval !== true) continue;
      if (!policyReviewedTools(candidate.connector, candidate.policy).some(entry => entry.slug === tool.slug)) continue;
      assertScopes(candidate, tool);
    } catch (error) {
      if (error instanceof ConnectorError && [403, 404, 409].includes(error.status)) continue;
      throw error;
    }
    if (selected) throw unavailable();
    selected = candidate;
  }
  if (!selected) throw unavailable();
  const credential = await loadConnectorCredential(trusted.siteId);
  if (credential.revision !== selected.provider.credential_revision) throw unavailable();
  const descriptor = await describeConnectorTool({ credential, connector: selected.connector, provider: selected.provider, toolSlug: tool.slug });
  if (descriptor.toolkitSlug !== tool.toolkit || descriptor.slug !== tool.slug || descriptor.scopeRequirements !== null) throw unavailable();
  assertScopes(selected, tool, descriptor.scopes);
  validateConnectorInput(reviewedInputSchema(tool.slug, descriptor.inputSchema), args);
  assertReviewedInputLimits(tool.slug, args);
  return requestProposal(trusted, actionSnapshot(origin, selected, descriptor, args));
}

/** Called only by the interactive runtime after describe, input, screen and authority checks. */
export async function proposeInteractiveConnectorAction(context: ConnectorContext, access: AuthorizedConnector, descriptor: Descriptor,
  args: Record<string, unknown>) {
  if (context.host !== 'assistant' || !context.instanceId || !context.agentId || !context.requestId || access.policy.require_approval !== true || access.requestOnly !== true) {
    throw new ConnectorError('APPROVAL_REQUIRED', 'An interactive request with a verified agent is required.', 403);
  }
  validateConnectorArguments(args);
  const action = actionSnapshot({ kind: 'interactive', instance_id: context.instanceId, user_id: context.userId }, access, descriptor, args);
  // Retrying the same host-owned turn must not mint another executable approval.
  const idempotencyKey = hashConnectorSchema([context.requestId, action.origin, action.connector_id, action.tool_slug, args]);
  return requestProposal({ siteId: context.siteId, conversationId: null, agentId: context.agentId, idempotencyKey,
    ...(context.sourceDigest && /^[a-f0-9]{64}$/.test(context.sourceDigest) && uuid.safeParse(context.requestId).success
      ? { source: { kind: 'instance_log' as const, id: context.requestId, digest: context.sourceDigest } } : {}) }, action);
}
