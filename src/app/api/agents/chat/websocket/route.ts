import { NextRequest } from 'next/server';
import {
  VisitorAuthorizationError, visitorAuthorizationErrorResponse, visitorSessionAuthorizationService,
} from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';
import { getConversationMessages, getOrCreateConversation, isValidUUID, saveMessage } from './conversation-store';
import { createRevalidation } from './realtime-authorization';
import { createEventStream } from './event-stream';

export const runtime = 'edge';
export const preferredRegion = 'auto';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function realtimeCorsHeaders(request: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': request.headers.get('origin') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Visitor-Session-Token, Accept',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

function failure(request: Request, error: unknown) {
  const response = visitorAuthorizationErrorResponse(error) || Response.json({
    success: false, error: { code: 'SERVER_ERROR', message: 'Unable to process realtime request' },
  }, { status: 500 });
  Object.entries(realtimeCorsHeaders(request)).forEach(([key, value]) => response.headers.set(key, value));
  return response;
}

function validateIds(siteId: unknown, conversationId: unknown, agentId: unknown) {
  if (!isValidUUID(siteId) || (conversationId && !isValidUUID(conversationId))
    || (agentId && !isValidUUID(agentId))) {
    throw new VisitorAuthorizationError('INVALID_PARAMETERS', 'Valid UUID parameters are required', 400);
  }
}

export async function OPTIONS(request: NextRequest) {
  return new Response(null, { status: 204, headers: realtimeCorsHeaders(request) });
}

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams;
    const siteId = query.get('site_id');
    const sessionId = query.get('session_id');
    const requestedConversation = query.get('conversation_id');
    const agentId = query.get('agent_id');
    validateIds(siteId, requestedConversation, agentId);
    const identity = await visitorSessionAuthorizationService.authorizeBrowserRequest({
      request, siteId, sessionId, conversationId: requestedConversation,
    });
    const visitorId = identity?.visitorId || query.get('visitor_id');
    if (!isValidUUID(visitorId)) {
      throw new VisitorAuthorizationError('INVALID_USER_ID', 'A valid visitor_id is required', 400);
    }
    const revalidate = await createRevalidation(request, siteId!, sessionId, identity);
    await revalidate();
    const conversationId = requestedConversation || await getOrCreateConversation(
      visitorId, siteId!, identity?.leadId || null, agentId,
    );
    // Authorize the resolved ID too, including the no-conversation-id fallback.
    await revalidate(conversationId);
    return new Response(createEventStream(request, conversationId, () => revalidate(conversationId)), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive', ...realtimeCorsHeaders(request),
      },
    });
  } catch (error) { return failure(request, error); }
}

export async function POST(request: NextRequest) {
  try {
    let body;
    try { body = await request.json(); } catch {
      throw new VisitorAuthorizationError('INVALID_JSON', 'Request body must be valid JSON', 400);
    }
    const payload = body?.type && body?.payload ? body.payload : body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new VisitorAuthorizationError('INVALID_PARAMETERS', 'A message object is required', 400);
    }
    const query = request.nextUrl.searchParams;
    const siteId = payload.site_id || query.get('site_id');
    const sessionId = payload.session_id || query.get('session_id');
    const requestedConversation = payload.conversation_id || query.get('conversation_id');
    validateIds(siteId, requestedConversation, payload.agent_id);
    const identity = await visitorSessionAuthorizationService.authorizeBrowserRequest({
      request, siteId, sessionId, conversationId: requestedConversation,
    });
    // Only an independently authorized service caller may supply a lead id.
    const leadId = identity ? identity.leadId : payload.lead_id || null;
    const visitorId = identity ? identity.visitorId : payload.visitor_id || leadId;
    if (!isValidUUID(visitorId) || (leadId && !isValidUUID(leadId))) {
      throw new VisitorAuthorizationError('INVALID_USER_ID', 'A valid visitor or lead id is required', 400);
    }
    const content = payload.message || payload.content;
    if (content !== undefined && (typeof content !== 'string' || content.length > 100_000)) {
      throw new VisitorAuthorizationError('INVALID_MESSAGE', 'Message content must be a string within 100000 characters', 400);
    }
    const revalidate = await createRevalidation(request, siteId, sessionId, identity);
    const user_type = leadId ? 'lead' : 'visitor';
    const user_id = leadId || visitorId;
    if (body.type === 'subscribe' && !content) {
      await revalidate(requestedConversation || undefined);
      return Response.json({ success: true, data: {
        type: 'subscription_ack', conversation_id: requestedConversation, user_type, user_id,
        message: 'Subscription processed. Use SSE GET to receive realtime messages.',
      } }, { headers: realtimeCorsHeaders(request) });
    }
    await revalidate();
    const conversationId = requestedConversation || await getOrCreateConversation(
      visitorId, siteId, leadId, payload.agent_id,
    );
    await revalidate(conversationId);
    if (content) {
      await saveMessage(conversationId, content, visitorId);
      await revalidate(conversationId);
    }
    const messages = await getConversationMessages(conversationId);
    await revalidate(conversationId);
    return Response.json({ success: true, data: {
      conversation_id: conversationId, user_type, user_id, visitor_id: visitorId, site_id: siteId, messages,
    } }, { headers: { 'Cache-Control': 'no-store', ...realtimeCorsHeaders(request) } });
  } catch (error) { return failure(request, error); }
}