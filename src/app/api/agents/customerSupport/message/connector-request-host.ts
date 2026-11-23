import { webChannels, websiteThread } from './web-thread';
import { sourceDigest } from '@/lib/connectors/approval-source';
import { verifyVisitorTurn } from '@/lib/connectors/channel-visitor-turn';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SupportConnectorHost, SupportConnectorScope } from '@/lib/connectors/support-runtime-contract';
import { extractApiKeyCredential, isServiceApiKeyCredential } from '@/lib/security/api-key-credential';
import { verifiedVisitorSessionClaims, visitorSessionTokenFromRequest } from '@/lib/security/visitor-session-token';
import { visitorSessionAuthorizationService, type CanonicalVisitorIdentity } from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { commentConversationId, sameCommentScope } from '@/lib/services/social-comments/metadata';
import { commentMessageIds } from '@/lib/services/social-comments/persistence';

const uuid = (v: unknown): v is string => z.string().uuid().safeParse(v).success;

/** Called after visitor ownership / provider admission, before command submission. Never select a replacement agent. */
export async function supportConnectorRequestHost(input: {
  request: Request; browserIdentity: CanonicalVisitorIdentity | null; siteId: string; conversationId?: string;
  agentId: string; origin?: string; channelDelivery?: boolean; suppliedAgentId?: unknown; requestedConversationId?: unknown;
  metadata?: Record<string, any>; inboundId?: string; visitorTurn?: unknown; message: string; originMessageId?: unknown;
}): Promise<SupportConnectorHost | undefined> {
  const { request, conversationId, siteId, agentId, browserIdentity: direct, metadata, inboundId } = input;
  if (!uuid(siteId) || !uuid(agentId) || !uuid(conversationId) || input.suppliedAgentId) return;
  const handoff = !direct && input.visitorTurn ? verifyVisitorTurn(input.visitorTurn, input.message, input.originMessageId) : undefined;
  if (input.visitorTurn !== undefined && !handoff) return;
  if (handoff && (handoff.conversationId !== conversationId || handoff.siteId !== siteId || metadata)) return;
  const visitor = direct || handoff;
  if (visitor && (!input.origin || !webChannels.has(input.origin) || input.channelDelivery || metadata?.source)) return;
  const browser = !!visitor && input.requestedConversationId === conversationId;
  const zavu = !visitor && metadata?.source === 'zavu_inbound_message' && uuid(inboundId)
    && typeof input.originMessageId === 'string' && !!input.originMessageId;
  const comment = !visitor && metadata?.source === 'comment' && !!metadata.platform_comment_id;
  if (!browser && !zavu && !comment) return;
  const turn = browser ? handoff?.turn || randomUUID() : zavu ? inboundId! : commentMessageIds(conversationId, metadata!.platform_comment_id).userMessageId;
  const digest = sourceDigest(input.message);
  const resolve = async (): Promise<SupportConnectorScope | null> => {
    let verifiedLeadId: string | undefined;
    if (browser) {
      const claims = handoff ? (await isServiceApiKeyCredential(extractApiKeyCredential(request)) &&
        verifyVisitorTurn(input.visitorTurn, input.message, input.originMessageId)) :
        await verifiedVisitorSessionClaims(visitorSessionTokenFromRequest(request), visitor!);
      if (!claims || claims.siteId !== siteId) return null;
      const current = await visitorSessionAuthorizationService.authorizeBrowserRequest({ request, siteId: claims.siteId, sessionId: claims.sessionId, conversationId });
      if (!current || current.siteId !== siteId || current.sessionId !== claims.sessionId
        || current.visitorId !== claims.visitorId || current.leadId !== visitor!.leadId) return null;
      // A signed session proves browser ownership, not customer identity. Only a
      // fresh canonical session with an active identity grant can bind a lead.
      if (current.leadId) verifiedLeadId = current.leadId;
    } else if (!await isServiceApiKeyCredential(extractApiKeyCredential(request))) return null;
    const db = supabaseAdmin.schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public');
    const {data: agent, error: agentError} = await db.from('agents').select('id,site_id,role,status')
      .eq('id', agentId).eq('site_id', siteId).eq('role', 'Customer Support').eq('status', 'active')
      .abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    if (agentError || agent?.id !== agentId || agent.site_id !== siteId || agent.role !== 'Customer Support' || agent.status !== 'active') return null;
    if (zavu) {
      const { data, error } = await db.from('messages').select('conversation_id, content, custom_data').eq('id', inboundId!)
        .eq('role', 'user').eq('agent_id', agentId).eq('custom_data->>source', 'zavu_inbound_message')
        .eq('custom_data->>connection_id', metadata!.connection_id).eq('custom_data->>zavu_sender_id', metadata!.zavu_sender_id)
        .eq('custom_data->>zavu_from', metadata!.zavu_from).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
      if (error || data?.conversation_id !== conversationId || data.content !== input.message
        || data.custom_data?.origin_message_id !== input.originMessageId) return null;
    }
    const { data: row, error } = await db.from('conversations').select('id, site_id, agent_id, visitor_id, lead_id, channel, custom_data')
      .eq('id', conversationId).eq('site_id', siteId).eq('agent_id', agentId).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    if (error || row?.id !== conversationId || row.site_id !== siteId || row.agent_id !== agentId) return null;
    if (visitor && !websiteThread(row.channel, row.custom_data)) return null;
    if (visitor && (row.lead_id ? row.lead_id !== visitor.leadId : row.visitor_id !== visitor.visitorId)) return null;
    if (comment && (row.id !== commentConversationId(row.site_id, metadata!) || !sameCommentScope(row.custom_data || {}, metadata!))) return null;
    // A signed-in visitor can also own older visitor-only conversations. Do
    // not persist verified-only answers in a thread still readable after logout.
    return { ...(verifiedLeadId && row.lead_id === verifiedLeadId ? { audience: 'verified' as const, leadId: verifiedLeadId } : { audience: 'anonymous' as const }),
      conversationId: row.id, siteId: row.site_id, agentId: row.agent_id, idempotencyKey: `channel-request:${turn}`,
      ...((zavu || comment) && { source: { kind: 'message' as const, id: turn, digest } }) };
  };
  try { if (await resolve()) return { siteId, agentId, resolve, messageDigest: digest }; } catch { /* Normal support remains available without connectors. */ }
}
