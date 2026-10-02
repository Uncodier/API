import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { visitorSessionAuthorizationService } from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';
import { isValidUUID } from './agent-data';
import { checkDuplicateOriginMessage } from './duplicate-message';
import { isInternalServiceRequest } from '@/lib/security/request-rate-limit';
import { commentConversationId, commentMetadata, SocialCommentError } from '@/lib/services/social-comments/metadata';
import { findCommentProposal } from '@/lib/services/social-comments/persistence';
export async function readSupportRequest(request: Request) {
    const body = await request.json();
    const browserIdentity = await visitorSessionAuthorizationService.authorizeBrowserRequest({
      request,
      siteId: body.site_id,
      sessionId: body.session_id,
      conversationId: body.conversationId
    });
    if (browserIdentity) {
      body.site_id = browserIdentity.siteId;
      body.visitor_id = browserIdentity.visitorId;
      body.lead_id = browserIdentity.leadId;
      body.userId = undefined;
      body.name = undefined;
      body.email = undefined;
      body.phone = undefined;
      body.origin_message_id = crypto.randomUUID();
    }

    console.log('[CustomerSupport] Request accepted', {
      hasConversationId: Boolean(body.conversationId),
      hasSessionId: Boolean(body.session_id),
      hasVisitorId: Boolean(body.visitor_id),
      hasLeadId: Boolean(body.lead_id),
      origin: request.headers.get('origin') || 'server'
    });


const { visitor_id, lead_id, userId, site_id, origin_message_id, conversationId } = body;
    if (body.custom_data?.source === 'comment') {
      if (browserIdentity || !isInternalServiceRequest(request)) {
        throw new SocialCommentError('Comment ingestion requires an authorized internal service', 403);
      }
      if (!isValidUUID(site_id) || typeof body.message !== 'string' || !body.message.trim()) {
        throw new SocialCommentError('A valid site and comment text are required', 400);
      }
      body.custom_data = commentMetadata(body.custom_data, body.origin);
      if (conversationId && conversationId !== commentConversationId(site_id, body.custom_data)) {
        throw new SocialCommentError('Comment conversation does not match the requested scope');
      }
      if (typeof origin_message_id === 'string') body.custom_data.origin_message_id = origin_message_id;
      const existing = await findCommentProposal(site_id, body.custom_data);
      if (existing) return NextResponse.json({ success: true, skipped: 'duplicate',
        message_id: existing.userMessageId, conversation_id: existing.conversationId });
    }
    // Verificamos si tenemos al menos un identificador de usuario o cliente
    if (!visitor_id && !lead_id && !userId && !site_id) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'At least one identification parameter (visitor_id, lead_id, userId, or site_id) is required' } },
        { status: 400 }
      );
    }
    
    // Validar que cualquier ID proporcionado sea un UUID válido
    if (userId && !isValidUUID(userId)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'userId must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    if (visitor_id && !isValidUUID(visitor_id)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'visitor_id must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    if (lead_id && !isValidUUID(lead_id)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'lead_id must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    if (site_id && !isValidUUID(site_id)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_REQUEST', message: 'site_id must be a valid UUID' } },
        { status: 400 }
      );
    }
    
    // Check for duplicate origin_message_id before processing
    if (origin_message_id && body.custom_data?.source !== 'comment') {
      const duplicateCheck = await checkDuplicateOriginMessage(
        origin_message_id,
        conversationId,
        lead_id,
        site_id
      );
      
      if (duplicateCheck.isDuplicate) {
        console.log(`⚠️ [DUPLICATE_CHECK] Message with origin_message_id ${origin_message_id} already processed and responded to. Skipping duplicate.`);
        return NextResponse.json(
          {
            success: true,
            message_id: duplicateCheck.existingMessageId,
            conversation_id: duplicateCheck.conversationId,
            skipped: 'duplicate',
            reason: 'Message with this origin_message_id already exists and was responded to'
          },
          { status: 200 }
        );
      }
    }
    

return { body, browserIdentity };
}
