import { sourceDigest } from './approval-source';
import { randomUUID } from 'node:crypto';
import { isPrivateSupportThread } from './support-thread';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveToolRequestPrincipal, canToolPrincipalAccessSite } from '@/lib/security/tool-request-principal';
import { extractApiKeyCredential } from '@/lib/security/api-key-credential';
import { supportConnectorTool, type SupportConnectorHost } from './support-runtime-contract';
import { isChannelConnectorDefinition } from './channel-tool-names';
import { channelRequestTool, type ChannelRequestHost } from './channel-request';
import { attachChannelRequestHost, attachSupportConnectorHost } from './channel-command';

type Locator = { siteId: unknown; agentId: unknown; conversationId: unknown };
type Command = { site_id?: string; agent_id?: string; user_id?: string; tools?: any[] };
const uuid = z.string().uuid();
const locator = z.object({siteId: uuid, agentId: uuid, conversationId: uuid});

/** The credential, live site membership and DB owner establish the actor, not user_id in JSON. */
function memberResolver(request: Request, candidate: Locator) {
  const parsed = locator.safeParse(candidate);
  if (!parsed.success || !extractApiKeyCredential(request)) return;
  const {siteId, agentId, conversationId} = parsed.data;
  const idempotencyKey = `channel-member:${randomUUID()}`;
  let actor: string | undefined;
  return { siteId, agentId, load: async () => {
    const principal = await resolveToolRequestPrincipal(request);
    if (!principal?.userId || principal.internal || (actor && principal.userId !== actor)
      || !await canToolPrincipalAccessSite(principal, siteId)) return null;
    const { data: row, error } = await supabaseAdmin.from('conversations').select('id,site_id,agent_id,user_id,lead_id,visitor_id,channel,custom_data')
      .eq('user_id',principal.userId).eq('id',conversationId).eq('site_id',siteId).eq('agent_id',agentId)
      .abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    if (error || row?.id !== conversationId || row.site_id !== siteId || row.agent_id !== agentId || row.user_id !== principal.userId) return null;
    actor = principal.userId;
    return { row, userId: principal.userId, scope: { conversationId, siteId, agentId, idempotencyKey } };
  } };
}

export async function memberConversationHost(request: Request, candidate: Locator & { commandUserId: unknown; message?: unknown }): Promise<SupportConnectorHost | undefined> {
  const source = memberResolver(request, candidate);
  if (!source) return;
  const { siteId, agentId } = source;
  const resolve: SupportConnectorHost['resolve'] = async () => {
    const owned = await source.load();
    if (!owned || owned.userId !== candidate.commandUserId) return null;
    const {row} = owned;
    // Support conversations can store the agent owner's user_id even on public threads.
    if (!isPrivateSupportThread(row)) return null;
    // The generic chat endpoint serves several agents. Its URL, agent name or
    // command role does not prove this is the active Customer Support agent.
    const {data: agent, error} = await supabaseAdmin.from('agents').select('id,site_id,role,status')
      .eq('id', agentId).eq('site_id', siteId).eq('role', 'Customer Support').eq('status', 'active')
      .abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    if (error || agent?.id !== agentId || agent.site_id !== siteId || agent.role !== 'Customer Support' || agent.status !== 'active') return null;
    return { ...owned.scope, audience: 'member', userId: owned.userId };
  };
  try { if (await resolve()) return { siteId, agentId, resolve, messageDigest: typeof candidate.message === 'string' ? sourceDigest(candidate.message) : undefined }; } catch { /* No authorization fallback. */ }
}

export async function enableMemberConversationReview(request: Request, command: Command, conversationId: unknown, message?: unknown) {
  command.tools = (command.tools || []).filter(tool => !isChannelConnectorDefinition(tool));
  const source = memberResolver(request, { siteId: command.site_id, agentId: command.agent_id, conversationId });
  if (!source) return;
  const resolve: ChannelRequestHost['resolve'] = async () => {
    const owned = await source.load();
    return owned && owned.userId === command.user_id && isPrivateSupportThread(owned.row)
      ? { ...owned.scope, memberUserId: owned.userId } : null;
  };
  try {
    if (!await resolve()) return;
    command.tools.push({ type: 'function', function: channelRequestTool });
    attachChannelRequestHost(command, { siteId: source.siteId, agentId: source.agentId, resolve, messageDigest: typeof message === 'string' ? sourceDigest(message) : undefined });
  } catch { /* An unavailable review capability does not interrupt normal chat. */ }
}

export async function enableMemberConversationGateway(request: Request, command: Command, conversationId: unknown, message?: unknown) {
  command.tools = (command.tools || []).filter(tool => !isChannelConnectorDefinition(tool));
  const host = await memberConversationHost(request, { siteId: command.site_id, agentId: command.agent_id,
    conversationId, message, commandUserId: command.user_id });
  if (!host) return enableMemberConversationReview(request, command, conversationId, message);
  command.tools.push({ type: 'function', function: supportConnectorTool }, { type: 'function', function: channelRequestTool });
  attachSupportConnectorHost(command, host);
}
