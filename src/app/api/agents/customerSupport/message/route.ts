import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { NextResponse } from 'next/server';
import { manageLeadCreation } from '@/lib/services/leads/lead-service';
import { OutstandLeadIdentityError } from '@/lib/services/leads/outstand-comment-identity';
import { WhatsAppLeadService } from '@/lib/services/whatsapp/WhatsAppLeadService';
import { ConversationService } from '@/lib/services/conversation-service';
import { visitorAuthorizationErrorResponse } from '@/lib/services/visitor-identity/VisitorSessionAuthorizationService';
import { isValidUUID, findActiveCustomerSupportAgent, getAgentInfo } from './agent-data';
import { readSupportRequest } from './request';
import { buildSupportContext } from './context';
import { generateSupportReply } from './generate';
import { resolveSupportResults } from './resolve-results';
import { getCommandById } from '@/lib/database/command-db';
import { saveMessages } from './save-messages';
import { disabledSupportNote } from './disabled-support';
import { corsHeaders } from './cors';
import { ensureCommentConversation, bindCommentAgent } from '@/lib/services/social-comments/conversations';
import { SocialCommentError } from '@/lib/services/social-comments/metadata';
import { checkZavuSupportAdmission } from './zavu-admission';
import { validateResponseFormat, type ResponseFormat } from '@/lib/services/channels/response-format';
import { selectSupportResponseFormat } from './response-format';
import { readSupportSnooze, resolveSnoozeConversation, saveSnoozedSupportInput } from './snooze';
import { saveZavuSupportMessages } from './save-zavu-messages';
import { reconcileConversationHumanEvents } from '@/lib/services/zavu/conversation-automation-contact';
import { validateSupportResponseMedia } from './response-media';
import { OutboundMediaError } from '@/lib/services/channels/outbound-media';
async function handleSupportRequest(request: Request) {
    try {
        const parsed = await readSupportRequest(request);
        if (parsed instanceof Response)
            return parsed;
        const { body, browserIdentity } = parsed;
        const initialZavuAdmission = await checkZavuSupportAdmission(request, body);
        if (initialZavuAdmission)
            return initialZavuAdmission;
        const requestTimestamp = new Date().toISOString();
        const clientIP = request.headers.get('x-forwarded-for') ||
            request.headers.get('x-real-ip') ||
            request.headers.get('x-client-ip') ||
            request.headers.get('cf-connecting-ip') ||
            'unknown';
        const userAgent = request.headers.get('user-agent') || 'unknown';
        const acceptLanguage = request.headers.get('accept-language') || 'unknown';
        console.log(`⏰ Request Info - Timestamp: ${requestTimestamp}, IP: ${clientIP}, User-Agent: ${userAgent}`);
        const { conversationId, userId, message, agentId, site_id, lead_id, visitor_id, name, email, phone, website_chat_origin, lead_notification, origin, origin_message_id, channel_delivery, require_approval, custom_data: inboundCustomData, channel_guidance_run_plan_ids, } = body;
        const validOrigins = ['website', 'email', 'sms', 'whatsapp', 'voice', 'chat', 'website_chat', 'none', 'api', 'telegram', 'messenger', 'instagram', 'facebook', 'threads', 'linkedin', 'x', 'youtube'];
        let effectiveOrigin = origin;
        if (!effectiveOrigin && request.headers.get('origin')) {
            effectiveOrigin = 'website';
            console.log(`🌐 No se proporcionó origin, pero se detectó header origin. Estableciendo automáticamente: ${effectiveOrigin}`);
        }
        if (effectiveOrigin && !validOrigins.includes(effectiveOrigin)) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: `origin must be one of: ${validOrigins.join(', ')}` } }, { status: 400 });
        }
        if (!message) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'message is required' } }, { status: 400 });
        }
        let explicitResponseFormat: ResponseFormat | undefined;
        try {
            explicitResponseFormat = validateResponseFormat(body.response_format, effectiveOrigin || 'chat');
        }
        catch (error) {
            return NextResponse.json({ success: false, error: {
                    code: 'INVALID_REQUEST', message: (error as Error).message,
                } }, { status: 400, headers: corsHeaders(request) });
        }
        let effectiveSiteId = site_id;
        if (effectiveSiteId) {
            console.log(`📍 Using provided site_id: ${effectiveSiteId}`);
        }
        else {
            console.log(`⚠️ No site_id provided for request`);
        }
        let leadOrigin = 'chat';
        if (effectiveOrigin) {
            leadOrigin = effectiveOrigin;
            console.log(`🏷️ Origen del lead establecido desde 'origin': ${leadOrigin}`);
        }
        else if (website_chat_origin === true) {
            leadOrigin = 'website_chat';
            console.log(`🏷️ Origen del lead establecido desde 'website_chat_origin': ${leadOrigin}`);
        }
        console.log(`🏷️ Origen final del lead: ${leadOrigin}`);
        let effectiveLeadId: string | null = null;
        let isNewLead = false;
        let taskId: string | null = null;
        let effectiveConversationId = conversationId;
        if (leadOrigin === 'whatsapp' && phone && effectiveSiteId) {
            console.log(`📱 Detectado origen WhatsApp - usando WhatsAppLeadService`);
            try {
                const whatsappResult = await WhatsAppLeadService.findOrCreateLeadAndConversation({
                    phoneNumber: phone,
                    senderName: name,
                    siteId: effectiveSiteId,
                    userId: userId,
                    businessAccountId: body.businessAccountId
                });
                effectiveLeadId = whatsappResult.leadId;
                isNewLead = whatsappResult.isNewLead;
                if (whatsappResult.conversationId && !conversationId) {
                    effectiveConversationId = whatsappResult.conversationId;
                    console.log(`💬 Usando conversación de WhatsApp existente: ${effectiveConversationId}`);
                }
                console.log(`📱 WhatsApp lead management completed - Lead: ${effectiveLeadId}, Conversation: ${effectiveConversationId || 'nueva'}`);
            }
            catch (error) {
                console.error(`❌ Error en WhatsAppLeadService:`, error);
                console.log(`🔄 Usando servicio estándar como fallback`);
                const leadManagementResult = await manageLeadCreation({
                    leadId: lead_id,
                    name,
                    email,
                    phone,
                    siteId: effectiveSiteId,
                    visitorId: visitor_id,
                    origin: leadOrigin,
                    createTask: false
                });
                effectiveLeadId = leadManagementResult.leadId;
                isNewLead = leadManagementResult.isNewLead;
                taskId = leadManagementResult.taskId;
            }
        }
        else {
            const leadManagementResult = await manageLeadCreation({
                leadId: lead_id,
                name,
                email,
                phone,
                siteId: effectiveSiteId,
                visitorId: visitor_id,
                origin: leadOrigin,
                createTask: website_chat_origin === true,
                socialCommentData: browserIdentity ? undefined : inboundCustomData,
                socialHandle: typeof inboundCustomData?.account_username === 'string'
                    ? inboundCustomData.account_username
                    : (typeof inboundCustomData?.social_handle === 'string' ? inboundCustomData.social_handle : undefined)
            });
            effectiveLeadId = leadManagementResult.leadId;
            isNewLead = leadManagementResult.isNewLead;
            taskId = leadManagementResult.taskId;
        }
        if (effectiveLeadId) {
            console.log(`👤 Usando lead_id: ${effectiveLeadId} para esta conversación. Es nuevo: ${isNewLead}`);
            if (taskId) {
                console.log(`✅ Tarea creada para el lead con ID: ${taskId}`);
            }
        }
        else {
            console.log(`⚠️ No hay lead_id disponible para esta conversación. Causas posibles:`);
            if (!name && !email && !phone) {
                console.log(`   - No se proporcionó información de contacto (nombre, email o teléfono)`);
            }
            else if (!name) {
                console.log(`   - Se proporcionó email/teléfono pero falta nombre`);
            }
            else {
                console.log(`   - Error al crear/buscar el lead en la base de datos (ver errores anteriores)`);
            }
        }
        if (inboundCustomData?.source === 'comment') {
            effectiveConversationId = await ensureCommentConversation({
                siteId: effectiveSiteId, metadata: inboundCustomData,
                conversationId, leadId: effectiveLeadId || undefined,
            });
        }
        if (!effectiveConversationId && leadOrigin !== 'whatsapp' && leadOrigin !== 'website_chat') {
            console.log(`🔍 Buscando conversación existente para origen "${effectiveOrigin || leadOrigin}"`);
            const existingConversationId = await ConversationService.findExistingConversation(effectiveLeadId || undefined, visitor_id, effectiveSiteId, effectiveOrigin || leadOrigin, phone, email);
            if (existingConversationId) {
                effectiveConversationId = existingConversationId;
                console.log(`✅ Usando conversación existente encontrada: ${effectiveConversationId}`);
            }
            else {
                console.log(`📝 No se encontró conversación existente, se creará una nueva`);
            }
        }
        else if (!effectiveConversationId && leadOrigin === 'website_chat') {
            console.log(`🌐 Para website_chat sin conversation_id, siempre se creará una nueva conversación`);
        }
        let effectiveAgentId = agentId;
        let agentUserId: string | null = null;
        let agentDisabled = false;
        if (!effectiveAgentId) {
            if (effectiveSiteId) {
                const foundAgent = await findActiveCustomerSupportAgent(effectiveSiteId);
                if (foundAgent) {
                    effectiveAgentId = foundAgent.agentId;
                    agentUserId = foundAgent.userId;
                    console.log(`🤖 Usando agente de soporte al cliente encontrado: ${effectiveAgentId} (user_id: ${agentUserId})`);
                }
                else {
                    effectiveAgentId = 'default_customer_support_agent';
                    agentDisabled = true;
                    console.log(`⚠️ No se encontró un agente activo, usando valor predeterminado: ${effectiveAgentId}`);
                }
            }
            else {
                effectiveAgentId = 'default_customer_support_agent';
                console.log(`⚠️ No se puede buscar un agente sin site_id, usando valor predeterminado: ${effectiveAgentId}`);
            }
        }
        else if (isValidUUID(effectiveAgentId)) {
            const agentInfo = await getAgentInfo(effectiveAgentId);
            if (agentInfo) {
                agentUserId = agentInfo.user_id;
                agentDisabled = !!agentInfo.status && agentInfo.status !== 'active';
                if (!effectiveSiteId && agentInfo.site_id) {
                    effectiveSiteId = agentInfo.site_id;
                    console.log(`📍 Usando site_id del agente: ${effectiveSiteId}`);
                }
            }
        }
        if (inboundCustomData?.source === 'comment' && isValidUUID(effectiveAgentId)) {
            await bindCommentAgent(effectiveSiteId, effectiveConversationId, effectiveAgentId);
        }
        const effectiveUserId = userId || agentUserId || visitor_id || lead_id;
        if (!effectiveUserId) {
            console.error(`❌ No se pudo determinar un user_id válido para el comando`);
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Unable to determine a valid user_id for the command' } }, { status: 400 });
        }
        console.log(`Creando comando para agente: ${effectiveAgentId}, usuario: ${effectiveUserId}, site: ${effectiveSiteId || 'N/A'}`);
        effectiveConversationId = await resolveSnoozeConversation({
            siteId: effectiveSiteId, conversationId: effectiveConversationId,
            metadata: inboundCustomData ? { ...inboundCustomData, channel: effectiveOrigin } : undefined,
        });
        let persistedInboundId: string | undefined;
        let automationStartedAt = requestTimestamp;
        if (!agentDisabled && inboundCustomData?.source === 'zavu_inbound_message' && origin_message_id) {
            const inbound = await saveZavuSupportMessages({
                siteId: effectiveSiteId, userId: effectiveUserId,
                agentId: isValidUUID(effectiveAgentId) ? effectiveAgentId : undefined,
                leadId: effectiveLeadId || undefined, conversationId: effectiveConversationId,
                userMessage: message, assistantMessage: '', originMessageId: origin_message_id,
                channel: effectiveOrigin, metadata: inboundCustomData, inboundOnly: true,
            });
            effectiveConversationId = inbound.conversationId;
            persistedInboundId = inbound.userMessageId;
            automationStartedAt = inbound.automationStartedAt || requestTimestamp;
            if (effectiveOrigin === 'whatsapp') {
                await reconcileConversationHumanEvents({ siteId: effectiveSiteId,
                    conversationId: effectiveConversationId, metadata: inboundCustomData });
            }
        }
        const snoozeInput = {
            siteId: effectiveSiteId, conversationId: effectiveConversationId,
            userId: effectiveUserId, message, leadId: effectiveLeadId || undefined, visitorId: visitor_id,
            agentId: isValidUUID(effectiveAgentId) ? effectiveAgentId : undefined,
            originMessageId: origin_message_id, metadata: inboundCustomData, startedAt: automationStartedAt, persistedInboundId,
        };
        const snoozedResponse = async () => {
            const state = await readSupportSnooze(snoozeInput);
            return state ? NextResponse.json(await saveSnoozedSupportInput(snoozeInput, state), { status: 200, headers: corsHeaders(request) }) : null;
        };
        const initialSnooze = await snoozedResponse();
        if (initialSnooze)
            return initialSnooze;
        if (agentDisabled) {
            const denied = await checkZavuSupportAdmission(request, body);
            if (denied)
                return denied;
            const note = await disabledSupportNote(effectiveSiteId);
            const saved = await saveMessages(effectiveUserId, message, note, effectiveConversationId, undefined, effectiveLeadId || undefined, visitor_id, isValidUUID(effectiveAgentId) ? effectiveAgentId : undefined, effectiveSiteId, undefined, effectiveOrigin || leadOrigin, false, false, false, origin_message_id, channel_delivery, false, inboundCustomData, true);
            if (!saved)
                throw new Error('CUSTOMER_SUPPORT_DISABLED_PERSISTENCE_FAILED');
            return NextResponse.json({ success: true, data: {
                    agent_disabled: true, response_skipped: true,
                    conversation_id: saved.conversationId, lead_id: effectiveLeadId || null, task_id: taskId || null,
                    messages: { user: { content: message, message_id: saved.userMessageId } },
                } }, { status: 200, headers: corsHeaders(request) });
        }
        const contextMessage = await buildSupportContext({ attachments: inboundCustomData?.attachments,
            response_format: explicitResponseFormat,
            custom_data: inboundCustomData, visitor_id, browserIdentity,
            request, message, name, email, phone, requestTimestamp, clientIP, userAgent, acceptLanguage,
            effectiveOrigin, effectiveLeadId, effectiveConversationId, effectiveSiteId,
            origin_message_id, channel_guidance_run_plan_ids, website_chat_origin });
        const deniedZavu = await checkZavuSupportAdmission(request, body);
        if (deniedZavu)
            return deniedZavu;
        const generated = await generateSupportReply({ effectiveUserId, effectiveAgentId, effectiveSiteId, effectiveLeadId, effectiveConversationId, contextMessage, agentUserId, request,
            response_format: explicitResponseFormat,
            ...(inboundCustomData?.source === 'zavu_inbound_message' ? {
                originMessageId: origin_message_id, connectionId: inboundCustomData.connection_id,
            } : {}),
        });
        if (generated instanceof Response)
            return generated;
        const { executedCommand, effectiveDbUuid } = generated;
        const resolved = await resolveSupportResults(executedCommand, async () => {
            const exactId = executedCommand.metadata?.dbUuid || executedCommand.id;
            if (!exactId || !isValidUUID(exactId))
                return null;
            const fresh = await getCommandById(exactId);
            if (!fresh || fresh.id !== exactId || fresh.site_id !== effectiveSiteId
                || fresh.agent_id !== effectiveAgentId || fresh.user_id !== effectiveUserId)
                return null;
            return fresh;
        });
        if (!resolved || resolved.assistantMessage === undefined) {
            return NextResponse.json({ success: false, error: { code: 'CUSTOMER_SUPPORT_EMPTY_RESPONSE',
                    message: 'The support command has no usable assistant response' } }, { status: 503, headers: { ...corsHeaders(request), 'Retry-After': '5' } });
        }
        const { assistantMessage, conversationTitle, isRobot, isTransactionalMessage, isErratic } = resolved;
        const lateSnooze = await snoozedResponse();
        if (lateSnooze)
            return lateSnooze;
        let responseFormat: ResponseFormat;
        try {
            responseFormat = selectSupportResponseFormat({ channel: effectiveOrigin,
                explicit: explicitResponseFormat, model: resolved.responseFormat, content: assistantMessage });
        }
        catch {
            return NextResponse.json({ success: false, error: {
                    code: 'CUSTOMER_SUPPORT_AUDIO_TOO_LONG', message: 'The generated audio script exceeds 4000 characters',
                } }, { status: 422, headers: corsHeaders(request) });
        }
        const responseMedia = await validateSupportResponseMedia(resolved.responseMedia, effectiveOrigin || 'chat', responseFormat, inboundCustomData?.source === 'comment');
        let savedMessages;
        try {
            savedMessages = await saveMessages(effectiveUserId, message, assistantMessage, effectiveConversationId, conversationTitle, effectiveLeadId || undefined, visitor_id, effectiveAgentId, effectiveSiteId, (effectiveDbUuid && isValidUUID(effectiveDbUuid)) ? effectiveDbUuid : undefined, effectiveOrigin || (leadOrigin !== 'chat' ? leadOrigin : undefined), isRobot, isTransactionalMessage, isErratic, origin_message_id, channel_delivery === true, require_approval === true, { ...(inboundCustomData && typeof inboundCustomData === 'object' ? inboundCustomData : {}),
                automation_started_at: automationStartedAt }, false, responseFormat, responseMedia);
        }
        catch (error: any) {
            if (error.code === 'SKIP_DATABASE' && error.results) {
                console.log(`🚨 SKIP_DATABASE detectado - retornando resultados sin crear objetos en DB`);
                return NextResponse.json({
                    success: true,
                    data: {
                        command_id: effectiveDbUuid,
                        skip_database: true,
                        response_format: responseFormat,
                        ...responseMedia,
                        results: {
                            message: error.results.message || assistantMessage,
                            ...responseMedia,
                            conversation_title: error.results.conversation_title || conversationTitle,
                            is_robot: error.results.is_robot || false,
                            is_transactional_message: error.results.is_transactional_message || false,
                            is_erratic: error.results.is_erratic || false
                        },
                        lead_id: effectiveLeadId || null,
                        task_id: taskId || null,
                        debug: {
                            agent_id: effectiveAgentId,
                            user_id: effectiveUserId,
                            agent_user_id: agentUserId,
                            site_id: effectiveSiteId
                        }
                    }
                }, {
                    status: 200,
                    headers: corsHeaders(request)
                });
            }
            throw error;
        }
        if (!savedMessages) {
            console.error(`❌ Error al guardar mensajes en la base de datos`);
            console.error(`❌ Context: command_id=${effectiveDbUuid}, lead_id=${effectiveLeadId}, conversation_id=${effectiveConversationId}`);
            return NextResponse.json({
                success: false,
                error: {
                    code: 'DATABASE_ERROR',
                    message: 'The command completed successfully but the messages could not be saved to the database. This may be due to a foreign key constraint failure, missing required data, or database connection issue. Check server logs for details.',
                    details: 'saveMessages() returned null instead of saved messages. Possible causes: invalid foreign key references (command_id, lead_id, conversation_id), database constraint violations, or connection errors.'
                },
                data: {
                    command_id: effectiveDbUuid,
                    message: assistantMessage,
                    conversation_title: conversationTitle,
                    lead_id: effectiveLeadId || null,
                    conversation_id: effectiveConversationId || null
                },
                debug: {
                    agent_id: effectiveAgentId,
                    user_id: effectiveUserId,
                    agent_user_id: agentUserId,
                    site_id: effectiveSiteId,
                    is_robot: isRobot,
                    is_transactional: isTransactionalMessage,
                    is_erratic: isErratic
                }
            }, {
                status: 500,
                headers: corsHeaders(request)
            });
        }
        return NextResponse.json({
            success: true,
            data: {
                command_id: effectiveDbUuid,
                conversation_id: savedMessages.conversationId,
                conversation_title: savedMessages.conversationTitle,
                response_format: responseFormat,
                ...responseMedia,
                lead_id: effectiveLeadId || null,
                task_id: taskId || null,
                messages: {
                    user: {
                        content: message,
                        message_id: savedMessages.userMessageId,
                        command_id: effectiveDbUuid
                    },
                    assistant: {
                        content: assistantMessage,
                        response_format: responseFormat,
                        ...responseMedia,
                        message_id: savedMessages.assistantMessageId,
                        command_id: effectiveDbUuid
                    }
                },
                debug: {
                    agent_id: effectiveAgentId,
                    user_id: effectiveUserId,
                    agent_user_id: agentUserId,
                    site_id: effectiveSiteId
                }
            }
        }, {
            status: 200,
            headers: corsHeaders(request)
        });
    }
    catch (error) {
        if (error instanceof OutboundMediaError || (error instanceof Error
            && error.message === 'CUSTOMER_SUPPORT_COMMENT_MEDIA_UNSUPPORTED'))
            return NextResponse.json({ success: false, error: { code: 'CUSTOMER_SUPPORT_INVALID_MEDIA', message: error.message } }, { status: 400, headers: corsHeaders(request) });
        if (error instanceof SocialCommentError)
            return NextResponse.json({ success: false, error: { code: 'SOCIAL_COMMENT_CONFLICT', message: error.message } }, { status: error.status });
        const authorizationResponse = visitorAuthorizationErrorResponse(error);
        if (authorizationResponse)
            return authorizationResponse;
        if (error instanceof OutstandLeadIdentityError) {
            return NextResponse.json({ success: false, error: { code: 'LEAD_IDENTITY_UNAVAILABLE', message: error.message } }, { status: 503 });
        }
        console.error(`❌ Error en el manejo de la solicitud:`, error);
        return NextResponse.json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred' } }, { status: 500 });
    }
}
export async function OPTIONS(request: Request) {
    console.log("[CORS-PREFLIGHT] Handling OPTIONS request");
    const origin = request.headers.get('origin') || '*';
    console.log(`[CORS-PREFLIGHT] Request origin: ${origin}`);
    const isAllowed = true;
    return new NextResponse(null, {
        status: 204,
        headers: corsHeaders(request)
    });
}

export async function POST(request: Request) {
 return withAuthorizedCommandRequest(request, handleSupportRequest, { visitorSession: true });
}
