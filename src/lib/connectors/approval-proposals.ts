import { z } from 'zod';
import { approvalSource } from './approval-source';
import { isPrivateSupportThread } from './support-thread';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { connectorDatabaseError, loadConnectorCredential } from './account-access';
import { actionSnapshot, unavailable, type Descriptor, type StoredAction } from './approval-action';
import { requestProposal, type ProposalScope } from './approval-store';
import { hashConnectorSchema,validateConnectorArguments } from './composio-tool-json';
import {describeDirectTool} from './provider-direct-transport';
import {assertDirectArguments} from './provider-direct-validation';
import {snapshotDirectJson} from './provider-direct-schema';
import {genericReviewTarget,uniqueAgentReviewAccount,reviewSlug} from './generic-review-target';
import { ConnectorError, type ConnectorContext, type AuthorizedConnector } from './types';

const uuid = z.string().uuid();
const scopeSchema = z.object({ siteId: uuid, conversationId: uuid, agentId: uuid, idempotencyKey: z.string().min(1).max(256), source: approvalSource.optional() }).strict();
const proposal = z.object({ tool_slug: reviewSlug, arguments: z.record(z.unknown()) }).strict();
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

/** No customer identity is a member, no account fallback, and no execution branch. */
export async function proposeConversationConnectorAction(scope: ProposalScope & { conversationId: string; memberUserId?: string; leadId?: string }, input: unknown) {
  const { memberUserId, leadId, ...binding } = scope;
  const trusted = scopeSchema.parse(binding);
  const origin = memberUserId !== undefined ? { kind: 'channel_member' as const, user_id: uuid.parse(memberUserId) }
    : { kind: 'channel_public' as const, lead_id: leadId === undefined ? null : uuid.parse(leadId) };
  const {tool_slug,arguments:args}=proposal.parse(snapshotDirectJson(input));
  if(Buffer.byteLength(JSON.stringify(args))>8192)throw unavailable();
  await requireConversationAgent(trusted.siteId,trusted.conversationId,trusted.agentId,origin);
  const id=await uniqueAgentReviewAccount(trusted.siteId,trusted.agentId,tool_slug);
  const authorize=()=>genericReviewTarget(trusted.siteId,trusted.agentId,id,tool_slug,memberUserId,'requester');
  const {target}=await authorize();
  const bindingHash=hashConnectorSchema(target);
  const credential=await loadConnectorCredential(trusted.siteId);
  const descriptor=await describeDirectTool(target,credential,tool_slug);
  assertDirectArguments(descriptor.parameters,args);
  await requireConversationAgent(trusted.siteId,trusted.conversationId,trusted.agentId,origin);
  if(hashConnectorSchema((await authorize()).target)!==bindingHash)throw unavailable();
  return requestProposal(trusted,{execution:'provider',origin,connector_id:id,account_label:target.connector.display_name,
    tool_slug,version:descriptor.version,schema_hash:descriptor.schemaHash,binding:bindingHash,scopes:[],arguments:args});
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
