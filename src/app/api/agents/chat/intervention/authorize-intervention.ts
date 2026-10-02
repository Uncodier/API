import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { canAccessSite, getRequestSitePrincipal } from '@/lib/security/site-access';
import { hasAuthenticatedPrincipal } from '@/lib/security/request-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { interventionCommentMetadata } from '@/lib/services/social-comments/reply-target';

const optionalId = z.string().uuid().nullish();
const requestSchema = z.object({
  conversationId: optionalId,
  conversation_id: optionalId,
  site_id: optionalId,
  user_id: optionalId,
  agentId: z.union([z.string().uuid(), z.literal('')]).nullish(),
  lead_id: optionalId,
  visitor_id: optionalId,
  message_id: optionalId,
  reply_to_message_id: optionalId,
  message: z.string().trim().min(1).max(20_000),
  conversation_title: z.string().trim().max(200).optional(),
}).strict();

export class InterventionRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function authorizeIntervention(request: Request, body: unknown) {
  // Middleware strips caller-supplied principal headers; use the same principal
  // and site authorization contract as the other private API handlers.
  const principal = getRequestSitePrincipal(request);
  if (!hasAuthenticatedPrincipal(request) || !principal.userId) {
    throw new InterventionRequestError('An authenticated user is required', 401);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) throw new InterventionRequestError('Invalid intervention request', 400);
  const input = parsed.data;
  const conversationId = input.conversationId || input.conversation_id;
  if (!conversationId || (input.conversationId && input.conversation_id
    && input.conversationId !== input.conversation_id)) {
    throw new InterventionRequestError('A single existing conversation is required', 400);
  }
  if (input.user_id && input.user_id !== principal.userId) {
    throw new InterventionRequestError('Intervention author does not match the authenticated user', 403);
  }
  const keyData = request.headers.get('x-api-key-data');
  if (keyData && !principal.internal) {
    let scopes: unknown;
    try { scopes = JSON.parse(keyData).scopes; } catch { /* Fail closed below. */ }
    if (!Array.isArray(scopes) || (!scopes.includes('write') && !scopes.includes('*'))) {
      throw new InterventionRequestError('Write scope is required', 403);
    }
  }
  const { data: conversation, error } = await supabaseAdmin.from('conversations')
    .select('id, site_id, agent_id, lead_id, visitor_id, title, custom_data').eq('id', conversationId).maybeSingle();
  if (error) throw new InterventionRequestError('Conversation access is unavailable', 503);
  if (!conversation?.site_id || (input.site_id && input.site_id !== conversation.site_id)
    || !await canAccessSite(request, conversation.site_id)) {
    throw new InterventionRequestError('Conversation access denied', 403);
  }
  if (!keyData) {
    const authorization = request.headers.get('authorization');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!authorization?.startsWith('Bearer ') || !url || !anonKey) {
      throw new InterventionRequestError('Authenticated write access is unavailable', 401);
    }
    const userClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization } },
    });
    const { data: allowed, error: permissionError } = await userClient.rpc('user_can', {
      p_site_id: conversation.site_id,
      p_command: input.message_id ? 'update' : 'insert',
    });
    if (permissionError || allowed !== true) {
      throw new InterventionRequestError('Intervention write access denied', 403);
    }
  }
  for (const [supplied, stored] of [
    [input.agentId, conversation.agent_id], [input.lead_id, conversation.lead_id],
    [input.visitor_id, conversation.visitor_id],
  ]) {
    if (supplied && supplied !== stored) throw new InterventionRequestError('Conversation resource mismatch', 403);
  }
  return {
    commentMetadata: await interventionCommentMetadata({
      siteId: conversation.site_id, conversationId, conversationData: conversation.custom_data,
      replyToMessageId: input.reply_to_message_id || undefined,
      retryMessageId: input.message_id || undefined, userId: principal.userId,
    }),
    conversationId,
    siteId: conversation.site_id as string,
    userId: principal.userId,
    agentId: conversation.agent_id as string | undefined,
    leadId: conversation.lead_id as string | undefined,
    visitorId: conversation.visitor_id as string | undefined,
    title: input.conversation_title || conversation.title || 'Intervention Conversation',
    message: input.message,
    messageId: input.message_id || undefined,
  };
}