import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { commandTools } from './command-tools';
import { isValidUUID, findActiveCmoAgent, getAgentInfo, commandService, getCommandDbUuid, waitForCommandCompletion, saveMessages } from './command-helpers-1';
import { getConversationHistory, formatConversationHistoryForContext } from './command-helpers-2';
async function handleCommandRequest(request: Request) {
    try {
        const body = await request.json();
        const { conversationId, userId, message, agentId, site_id, lead_id, visitor_id } = body;
        if (!visitor_id && !lead_id && !userId && !site_id) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'At least one identification parameter (visitor_id, lead_id, userId, or site_id) is required' } }, { status: 400 });
        }
        if (userId && !isValidUUID(userId)) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'userId must be a valid UUID' } }, { status: 400 });
        }
        if (visitor_id && !isValidUUID(visitor_id)) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'visitor_id must be a valid UUID' } }, { status: 400 });
        }
        if (lead_id && !isValidUUID(lead_id)) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'lead_id must be a valid UUID' } }, { status: 400 });
        }
        if (site_id && !isValidUUID(site_id)) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'site_id must be a valid UUID' } }, { status: 400 });
        }
        if (!message) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'message is required' } }, { status: 400 });
        }
        let effectiveSiteId = site_id;
        if (effectiveSiteId) {
            console.log(`📍 Using provided site_id: ${effectiveSiteId}`);
        }
        else {
            console.log(`⚠️ No site_id provided for request`);
        }
        let effectiveAgentId = agentId;
        let agentUserId: string | null = null;
        if (!effectiveAgentId) {
            if (effectiveSiteId) {
                const foundAgent = await findActiveCmoAgent(effectiveSiteId);
                if (foundAgent) {
                    effectiveAgentId = foundAgent.agentId;
                    agentUserId = foundAgent.userId;
                    console.log(`🤖 Usando agente de CMO encontrado: ${effectiveAgentId} (user_id: ${agentUserId})`);
                }
                else {
                    effectiveAgentId = 'default_cmo_agent';
                    console.log(`⚠️ No se encontró un agente activo, usando valor predeterminado: ${effectiveAgentId}`);
                }
            }
            else {
                effectiveAgentId = 'default_cmo_agent';
                console.log(`⚠️ No se puede buscar un agente sin site_id, usando valor predeterminado: ${effectiveAgentId}`);
            }
        }
        else if (isValidUUID(effectiveAgentId)) {
            const agentInfo = await getAgentInfo(effectiveAgentId);
            if (agentInfo) {
                agentUserId = agentInfo.user_id;
                if (!effectiveSiteId && agentInfo.site_id) {
                    effectiveSiteId = agentInfo.site_id;
                    console.log(`📍 Usando site_id del agente: ${effectiveSiteId}`);
                }
            }
        }
        const effectiveUserId = userId || agentUserId || visitor_id || lead_id;
        if (!effectiveUserId) {
            console.error(`❌ No se pudo determinar un user_id válido para el comando`);
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Unable to determine a valid user_id for the command' } }, { status: 400 });
        }
        console.log(`Creando comando para agente CMO: ${effectiveAgentId}, usuario: ${effectiveUserId}, site: ${effectiveSiteId || 'N/A'}`);
        let contextMessage = `Current message: ${message}`;
        if (conversationId && isValidUUID(conversationId)) {
            console.log(`🔄 Recuperando historial para la conversación: ${conversationId}`);
            const historyMessages = await getConversationHistory(conversationId);
            if (historyMessages && historyMessages.length > 0) {
                const filteredMessages = historyMessages.filter(msg => {
                    if (msg.role === 'assistant' || msg.role === 'team_member' || msg.role === 'system') {
                        return true;
                    }
                    return msg.content.trim() !== message.trim();
                });
                if (filteredMessages.length > 0) {
                    const conversationHistory = formatConversationHistoryForContext(filteredMessages);
                    contextMessage = `${contextMessage}\n\nConversation History:\n${conversationHistory}\n\nConversation ID: ${conversationId}`;
                    console.log(`📜 Historial de conversación recuperado con ${filteredMessages.length} mensajes`);
                }
                else {
                    contextMessage = `${contextMessage}\nConversation ID: ${conversationId}`;
                }
            }
            else {
                contextMessage = `${contextMessage}\nConversation ID: ${conversationId}`;
                console.log(`⚠️ No se encontró historial para la conversación: ${conversationId}`);
            }
        }
        const command = CommandFactory.createCommand({
            task: 'create message',
            userId: effectiveUserId,
            agentId: effectiveAgentId,
            agentRole: 'Growth Lead/Manager',
            ...(effectiveSiteId ? { site_id: effectiveSiteId } : {}),
            description: 'Engage with the marketing team, understand their strategic needs, provide relevant marketing insights, address campaign performance questions, and guide them toward developing effective marketing strategies.',
            targets: [
                {
                    message: {
                        content: "message example"
                    }
                },
                {
                    conversation: {
                        title: "conversation title"
                    }
                }
            ],
            tools: commandTools(),
            context: contextMessage,
            supervisor: [
                {
                    agent_role: "marketing_director",
                    status: "not_initialized"
                },
                {
                    agent_role: "data_analyst",
                    status: "not_initialized"
                }
            ]
        });
        const internalCommandId = await commandService.submitCommand(command);
        console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
        let initialDbUuid = await getCommandDbUuid(internalCommandId);
        if (initialDbUuid) {
            console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
        }
        const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
        const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
        if (!effectiveDbUuid || !isValidUUID(effectiveDbUuid)) {
            console.error(`❌ No se pudo obtener un UUID válido de la base de datos para el comando ${internalCommandId}`);
            console.log(`⚠️ Continuando con el ID interno como respaldo: ${internalCommandId}`);
            if (!completed || !executedCommand) {
                let assistantMessage = "No response generated";
                let conversationTitle = null;
                if (executedCommand.results && Array.isArray(executedCommand.results)) {
                    const conversationResults = executedCommand.results.find((r: any) => r.conversation && r.conversation.title);
                    if (conversationResults) {
                        conversationTitle = conversationResults.conversation.title;
                        console.log(`🏷️ Título de conversación encontrado: "${conversationTitle}"`);
                    }
                    else {
                        const altTitleResults = executedCommand.results.find((r: any) => (r.content && r.content.conversation && r.content.conversation.title) ||
                            (r.type === 'conversation' && r.content && r.content.title));
                        if (altTitleResults) {
                            if (altTitleResults.content && altTitleResults.content.conversation) {
                                conversationTitle = altTitleResults.content.conversation.title;
                            }
                            else if (altTitleResults.content && altTitleResults.content.title) {
                                conversationTitle = altTitleResults.content.title;
                            }
                            console.log(`🏷️ Título de conversación encontrado (formato alternativo): "${conversationTitle}"`);
                        }
                    }
                    console.log(`🔍 Buscando mensaje del asistente en los resultados...`);
                    const messageObject = executedCommand.results.find((r: any) => r && r.message && r.message.content);
                    if (messageObject) {
                        assistantMessage = messageObject.message.content;
                        console.log(`✅ Mensaje extraído de objeto con property message directa: ${assistantMessage.substring(0, 50)}...`);
                    }
                    else {
                        const typeResults = executedCommand.results.filter((r: any) => r && (r.type === 'message' || r.type === 'text'));
                        if (typeResults.length > 0) {
                            const firstTypeResult = typeResults[0];
                            if (typeof firstTypeResult.content === 'string') {
                                assistantMessage = firstTypeResult.content;
                            }
                            else if (firstTypeResult.content && firstTypeResult.content.message && firstTypeResult.content.message.content) {
                                assistantMessage = firstTypeResult.content.message.content;
                            }
                            else if (firstTypeResult.content && typeof firstTypeResult.content.content === 'string') {
                                assistantMessage = firstTypeResult.content.content;
                            }
                            console.log(`✅ Mensaje extraído de resultado con type=${firstTypeResult.type}: ${assistantMessage.substring(0, 50)}...`);
                        }
                        if (assistantMessage === "No response generated") {
                            const contentObject = executedCommand.results.find((r: any) => r && r.content !== undefined && (typeof r.content === 'string' ||
                                (typeof r.content === 'object' && (r.content.content || r.content.message))));
                            if (contentObject) {
                                if (typeof contentObject.content === 'string') {
                                    assistantMessage = contentObject.content;
                                }
                                else if (contentObject.content.message && contentObject.content.message.content) {
                                    assistantMessage = contentObject.content.message.content;
                                }
                                else if (contentObject.content.content) {
                                    assistantMessage = typeof contentObject.content.content === 'string'
                                        ? contentObject.content.content
                                        : JSON.stringify(contentObject.content.content);
                                }
                                console.log(`✅ Mensaje extraído de objeto con property content: ${assistantMessage.substring(0, 50)}...`);
                            }
                            else if (executedCommand.results.length > 0) {
                                const firstResult = executedCommand.results[0];
                                if (typeof firstResult === 'string') {
                                    assistantMessage = firstResult;
                                    console.log(`⚠️ Usando fallback para string directo: ${assistantMessage.substring(0, 50)}...`);
                                }
                                else if (typeof firstResult === 'object') {
                                    const extractedContent = firstResult.content ||
                                        firstResult.message?.content ||
                                        firstResult.text ||
                                        JSON.stringify(firstResult);
                                    assistantMessage = typeof extractedContent === 'string'
                                        ? extractedContent
                                        : JSON.stringify(extractedContent);
                                    console.log(`⚠️ Usando fallback para objeto genérico: ${assistantMessage.substring(0, 50)}...`);
                                }
                            }
                            else {
                                console.log(`❌ No se pudo extraer mensaje - no hay resultados o estructura no reconocida`);
                                console.log(`📋 Estructura completa de results:`, JSON.stringify(executedCommand.results, null, 2));
                            }
                        }
                    }
                }
                console.log(`💬 Mensaje del asistente: ${assistantMessage.substring(0, 50)}...`);
                const savedMessages = await saveMessages(effectiveUserId, message, assistantMessage, conversationId, conversationTitle, lead_id, visitor_id, effectiveAgentId, effectiveSiteId, internalCommandId);
                if (!savedMessages) {
                    console.error(`❌ Error al guardar mensajes en la base de datos`);
                    return NextResponse.json({
                        success: false,
                        error: {
                            code: 'DATABASE_ERROR',
                            message: 'The command completed but the messages could not be saved to the database'
                        },
                        data: {
                            command_id: internalCommandId,
                            message: assistantMessage,
                            conversation_title: conversationTitle
                        },
                        debug: {
                            agent_id: effectiveAgentId,
                            user_id: effectiveUserId,
                            agent_user_id: agentUserId,
                            site_id: effectiveSiteId
                        }
                    }, { status: 500 });
                }
                return NextResponse.json({
                    success: true,
                    data: {
                        command_id: internalCommandId,
                        conversation_id: savedMessages?.conversationId,
                        conversation_title: savedMessages?.conversationTitle,
                        messages: {
                            user: {
                                content: message,
                                message_id: savedMessages?.userMessageId,
                                command_id: internalCommandId
                            },
                            assistant: {
                                content: assistantMessage,
                                message_id: savedMessages?.assistantMessageId,
                                command_id: internalCommandId
                            }
                        }
                    }
                }, { status: 200 });
            }
        }
        if (!completed || !executedCommand) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'COMMAND_EXECUTION_FAILED',
                    message: 'The command did not complete successfully in the expected time'
                },
                debug: {
                    agent_id: effectiveAgentId,
                    user_id: effectiveUserId,
                    agent_user_id: agentUserId,
                    site_id: effectiveSiteId
                }
            }, { status: 500 });
        }
        let assistantMessage = "No response generated";
        let conversationTitle = null;
        if (executedCommand.results && Array.isArray(executedCommand.results)) {
            const conversationResults = executedCommand.results.find((r: any) => r.conversation && r.conversation.title);
            if (conversationResults) {
                conversationTitle = conversationResults.conversation.title;
                console.log(`🏷️ Título de conversación encontrado: "${conversationTitle}"`);
            }
            else {
                const altTitleResults = executedCommand.results.find((r: any) => (r.content && r.content.conversation && r.content.conversation.title) ||
                    (r.type === 'conversation' && r.content && r.content.title));
                if (altTitleResults) {
                    if (altTitleResults.content && altTitleResults.content.conversation) {
                        conversationTitle = altTitleResults.content.conversation.title;
                    }
                    else if (altTitleResults.content && altTitleResults.content.title) {
                        conversationTitle = altTitleResults.content.title;
                    }
                    console.log(`🏷️ Título de conversación encontrado (formato alternativo): "${conversationTitle}"`);
                }
            }
            console.log(`🔍 Buscando mensaje del asistente en los resultados...`);
            const messageObject = executedCommand.results.find((r: any) => r && r.message && r.message.content);
            if (messageObject) {
                assistantMessage = messageObject.message.content;
                console.log(`✅ Mensaje extraído de objeto con property message directa: ${assistantMessage.substring(0, 50)}...`);
            }
            else {
                const typeResults = executedCommand.results.filter((r: any) => r && (r.type === 'message' || r.type === 'text'));
                if (typeResults.length > 0) {
                    const firstTypeResult = typeResults[0];
                    if (typeof firstTypeResult.content === 'string') {
                        assistantMessage = firstTypeResult.content;
                    }
                    else if (firstTypeResult.content && firstTypeResult.content.message && firstTypeResult.content.message.content) {
                        assistantMessage = firstTypeResult.content.message.content;
                    }
                    else if (firstTypeResult.content && typeof firstTypeResult.content.content === 'string') {
                        assistantMessage = firstTypeResult.content.content;
                    }
                    console.log(`✅ Mensaje extraído de resultado con type=${firstTypeResult.type}: ${assistantMessage.substring(0, 50)}...`);
                }
                if (assistantMessage === "No response generated") {
                    const contentObject = executedCommand.results.find((r: any) => r && r.content !== undefined && (typeof r.content === 'string' ||
                        (typeof r.content === 'object' && (r.content.content || r.content.message))));
                    if (contentObject) {
                        if (typeof contentObject.content === 'string') {
                            assistantMessage = contentObject.content;
                        }
                        else if (contentObject.content.message && contentObject.content.message.content) {
                            assistantMessage = contentObject.content.message.content;
                        }
                        else if (contentObject.content.content) {
                            assistantMessage = typeof contentObject.content.content === 'string'
                                ? contentObject.content.content
                                : JSON.stringify(contentObject.content.content);
                        }
                        console.log(`✅ Mensaje extraído de objeto con property content: ${assistantMessage.substring(0, 50)}...`);
                    }
                    else if (executedCommand.results.length > 0) {
                        const firstResult = executedCommand.results[0];
                        if (typeof firstResult === 'string') {
                            assistantMessage = firstResult;
                            console.log(`⚠️ Usando fallback para string directo: ${assistantMessage.substring(0, 50)}...`);
                        }
                        else if (typeof firstResult === 'object') {
                            const extractedContent = firstResult.content ||
                                firstResult.message?.content ||
                                firstResult.text ||
                                JSON.stringify(firstResult);
                            assistantMessage = typeof extractedContent === 'string'
                                ? extractedContent
                                : JSON.stringify(extractedContent);
                            console.log(`⚠️ Usando fallback para objeto genérico: ${assistantMessage.substring(0, 50)}...`);
                        }
                    }
                    else {
                        console.log(`❌ No se pudo extraer mensaje - no hay resultados o estructura no reconocida`);
                        console.log(`📋 Estructura completa de results:`, JSON.stringify(executedCommand.results, null, 2));
                    }
                }
            }
        }
        console.log(`💬 Mensaje del asistente: ${assistantMessage.substring(0, 50)}...`);
        const savedMessages = await saveMessages(effectiveUserId, message, assistantMessage, conversationId, conversationTitle, lead_id, visitor_id, effectiveAgentId, effectiveSiteId, effectiveDbUuid || undefined);
        if (!savedMessages) {
            console.error(`❌ Error al guardar mensajes en la base de datos`);
            return NextResponse.json({
                success: false,
                error: {
                    code: 'DATABASE_ERROR',
                    message: 'The command completed but the messages could not be saved to the database'
                },
                data: {
                    command_id: effectiveDbUuid,
                    message: assistantMessage,
                    conversation_title: conversationTitle
                },
                debug: {
                    agent_id: effectiveAgentId,
                    user_id: effectiveUserId,
                    agent_user_id: agentUserId,
                    site_id: effectiveSiteId
                }
            }, { status: 500 });
        }
        return NextResponse.json({
            success: true,
            data: {
                command_id: effectiveDbUuid,
                conversation_id: savedMessages.conversationId,
                conversation_title: savedMessages.conversationTitle,
                messages: {
                    user: {
                        content: message,
                        message_id: savedMessages.userMessageId,
                        command_id: effectiveDbUuid
                    },
                    assistant: {
                        content: assistantMessage,
                        message_id: savedMessages.assistantMessageId,
                        command_id: effectiveDbUuid
                    }
                }
            }
        }, { status: 200 });
    }
    catch (error) {
        console.error('Error al procesar la solicitud:', error);
        return NextResponse.json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } }, { status: 500 });
    }
}
export async function POST(request: Request) { return withAuthorizedCommandRequest(request, handleCommandRequest); }
