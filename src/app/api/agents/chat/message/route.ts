import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { getCommerceReservationsPolicy } from '@/app/api/agents/customerSupport/support-policies';
import { buildChatMessageTools } from './tools';
import { isValidUUID, getCommandDbUuid, waitForCommandCompletion, saveMessages } from './command-helpers-1';
import { getConversationHistory, formatConversationHistoryForContext, getAgentInfo, getTeamMemberInfo } from './command-helpers-2';
async function handleCommandRequest(request: Request) {
    try {
        const processorInitializer = ProcessorInitializer.getInstance();
        processorInitializer.initialize();
        const commandService = processorInitializer.getCommandService();
        const body = await request.json();
        const origin = request.headers.get('origin') || request.headers.get('referer');
        const channel = origin ? origin : 'web';
        const { conversationId, message, agentId, lead_id, visitor_id, site_id, team_member_id } = body;
        console.log(`📨 Parámetros recibidos: agentId=${agentId}, team_member_id=${team_member_id || 'no proporcionado'}`);
        if (!message) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'message is required' } }, { status: 400 });
        }
        if (!agentId) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'agentId is required' } }, { status: 400 });
        }
        if (!site_id) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'site_id is required' } }, { status: 400 });
        }
        const agentInfo = await getAgentInfo(agentId);
        if (!agentInfo) {
            return NextResponse.json({ success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } }, { status: 404 });
        }
        const userId = team_member_id || agentInfo.user_id;
        console.log(`👤 Determinación de usuario: team_member_id=${team_member_id || 'no proporcionado'}, userId asignado=${userId}`);
        console.log(`Creando comando para agente: ${agentId}, propietario: ${userId}, site: ${site_id}`);
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
        if (lead_id) {
            contextMessage = `${contextMessage}\nLead ID: ${lead_id}`;
        }
        if (visitor_id) {
            contextMessage = `${contextMessage}\nVisitor ID: ${visitor_id}`;
        }
        if (site_id) {
            contextMessage = `${contextMessage}\nSite ID: ${site_id}`;
        }
        if (team_member_id) {
            const teamMemberInfo = await getTeamMemberInfo(team_member_id);
            if (teamMemberInfo) {
                console.log(`✅ Añadiendo información detallada del miembro del equipo al contexto`);
                contextMessage = `${contextMessage}\n\nCurrent User data and personal information (as a team member of your company):`;
                contextMessage = `${contextMessage}\nID: ${team_member_id}`;
                if (teamMemberInfo.name)
                    contextMessage = `${contextMessage}\nName: ${teamMemberInfo.name}`;
                if (teamMemberInfo.email)
                    contextMessage = `${contextMessage}\nEmail: ${teamMemberInfo.email}`;
                if (teamMemberInfo.role)
                    contextMessage = `${contextMessage}\nRole: ${teamMemberInfo.role}`;
                if (teamMemberInfo.department)
                    contextMessage = `${contextMessage}\nDepartment: ${teamMemberInfo.department}`;
                if (teamMemberInfo.title)
                    contextMessage = `${contextMessage}\nTitle: ${teamMemberInfo.title}`;
                if (teamMemberInfo.bio)
                    contextMessage = `${contextMessage}\nBio: ${teamMemberInfo.bio}`;
                if (teamMemberInfo.avatar_url)
                    contextMessage = `${contextMessage}\nAvatar URL: ${teamMemberInfo.avatar_url}`;
                if (teamMemberInfo.phone)
                    contextMessage = `${contextMessage}\nPhone: ${teamMemberInfo.phone}`;
                if (teamMemberInfo.custom_fields && typeof teamMemberInfo.custom_fields === 'object') {
                    contextMessage = `${contextMessage}\n\nCustom Fields:`;
                    for (const [key, value] of Object.entries(teamMemberInfo.custom_fields)) {
                        if (value !== null && value !== undefined) {
                            contextMessage = `${contextMessage}\n${key}: ${value}`;
                        }
                    }
                }
            }
            else {
                contextMessage = `${contextMessage}\nTeam Member ID: ${team_member_id}`;
            }
        }
        const defaultTools: any[] = [
            {
                "type": "function",
                "function": {
                    "name": "GET_LEAD_DETAILS",
                    "description": "Get details about a lead by providing name, email, company, or phone",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {
                                "type": "string",
                                "description": "The name of the lead."
                            },
                            "mail": {
                                "type": "string",
                                "description": "The email address of the lead."
                            },
                            "company": {
                                "type": "string",
                                "description": "The company name associated with the lead."
                            },
                            "phone": {
                                "type": "string",
                                "description": "The phone number of the lead."
                            }
                        },
                        "additionalProperties": false
                    },
                    "strict": true
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "SAVE_LEAD_DETAILS",
                    "description": "Save or update lead information in the database",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {
                                "type": "string",
                                "description": "The name of the lead."
                            },
                            "email": {
                                "type": "string",
                                "description": "The email address of the lead."
                            },
                            "company": {
                                "type": "string",
                                "description": "The company name associated with the lead."
                            },
                            "phone": {
                                "type": "string",
                                "description": "The phone number of the lead."
                            },
                            "source": {
                                "type": "string",
                                "description": "The source of the lead (e.g. website, referral, social)."
                            },
                            "status": {
                                "type": "string",
                                "description": "The status of the lead (e.g. new, contacted, qualified)."
                            },
                            "notes": {
                                "type": "string",
                                "description": "Additional notes or information about the lead."
                            }
                        },
                        "required": [
                            "name",
                            "email"
                        ],
                        "additionalProperties": false
                    },
                    "strict": true
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "GET_TASK_DETAILS",
                    "description": "Get details about a task by providing the task ID and a query for the name",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "id": {
                                "type": "string",
                                "description": "The ID of the task."
                            },
                            "query": {
                                "type": "string",
                                "description": "The query to search for the task name."
                            }
                        },
                        "required": [
                            "query"
                        ],
                        "additionalProperties": false
                    },
                    "strict": true
                }
            }
        ];
        const additionalTools = agentInfo.tools && Array.isArray(agentInfo.tools) && agentInfo.tools.length > 0
            ? agentInfo.tools
            : defaultTools;
        const tools = buildChatMessageTools(site_id, additionalTools);
        contextMessage += getCommerceReservationsPolicy();
        const hasActivities = agentInfo.activities && Array.isArray(agentInfo.activities) && agentInfo.activities.length > 0;
        const activities = agentInfo.activities || [];
        console.log(`🔧 Using ${tools.length} tools from the support baseline and chat/agent configuration`);
        if (hasActivities) {
            console.log(`🔧 Including ${activities.length} activities from agent configuration`);
        }
        const command = CommandFactory.createCommand({
            task: 'create message',
            userId,
            agentId,
            ...(site_id ? { site_id } : {}),
            description: 'Respond helpfully to the user\'s inquiry, provide relevant insights, and assist with the requested task using available tools and knowledge. For any complex request, ALWAYS use the skill lookup tool at the beginning to search for relevant skills or procedures to follow BEFORE proceeding.',
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
            tools,
            ...(hasActivities ? { activities } : {}),
            context: contextMessage,
            supervisor: [
                {
                    agent_role: 'specialist',
                    status: 'not_initialized'
                },
                {
                    agent_role: 'manager',
                    status: 'not_initialized'
                }
            ],
            modelType: 'openrouter'
        });
        const internalCommandId = await commandService.submitCommand(command);
        console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
        let initialDbUuid = await getCommandDbUuid(internalCommandId, commandService);
        if (initialDbUuid) {
            console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
        }
        const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId, commandService);
        const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
        if (!completed) {
            console.warn(`⚠️ Comando ${internalCommandId} no completó exitosamente en el tiempo esperado`);
            if (!executedCommand || !executedCommand.results || executedCommand.results.length === 0) {
                return NextResponse.json({
                    success: false,
                    error: {
                        code: 'COMMAND_EXECUTION_FAILED',
                        message: 'El comando no completó exitosamente y no se generaron resultados válidos'
                    }
                }, { status: 500 });
            }
            else {
                console.log(`⚠️ Comando en estado ${executedCommand.status} pero tiene ${executedCommand.results.length} resultados, continuando`);
            }
        }
        let assistantMessage = "No response generated";
        let conversationTitle = null;
        if (executedCommand.results && Array.isArray(executedCommand.results)) {
            console.log(`Resultados encontrados: ${JSON.stringify(executedCommand.results).substring(0, 200)}...`);
            if (executedCommand.results.length === 0) {
                console.warn("⚠️ El comando completó correctamente pero no se encontraron resultados");
            }
            else {
                executedCommand.results.forEach((result: any, idx: number) => {
                    const type = result.type || 'sin_tipo';
                    const hasMessage = result.message !== undefined;
                    const hasContent = result.content !== undefined;
                    console.log(`📋 Resultado ${idx}: type=${type}, hasMessage=${hasMessage}, hasContent=${hasContent}`);
                });
            }
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
                else if (assistantMessage === "No response generated") {
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
                        }
                        else if (typeof firstResult === 'object') {
                            const extractedContent = firstResult.content ||
                                firstResult.message?.content ||
                                firstResult.text ||
                                JSON.stringify(firstResult);
                            assistantMessage = typeof extractedContent === 'string'
                                ? extractedContent
                                : JSON.stringify(extractedContent);
                        }
                        console.log(`✅ Mensaje extraído como último recurso del primer resultado: ${assistantMessage.substring(0, 50)}...`);
                    }
                }
            }
        }
        else {
            console.warn("⚠️ No se encontraron resultados en el comando ejecutado");
        }
        console.log(`💬 Mensaje final del asistente: ${assistantMessage.substring(0, 50)}...`);
        console.log(`🔄 Iniciando guardado de mensajes en la base de datos...`);
        console.log(`🧩 Parámetros de guardado: userId=${userId}, team_member_id=${team_member_id}`);
        let savedMessages = null;
        try {
            try {
                const savedMessagesPromise = saveMessages(userId, message, assistantMessage, conversationId, lead_id, visitor_id, conversationTitle, agentId, team_member_id, effectiveDbUuid || internalCommandId, channel);
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout saving messages')), 10000));
                savedMessages = await Promise.race([savedMessagesPromise, timeoutPromise]) as any;
                if (!savedMessages) {
                    console.error(`❌ Error al guardar los mensajes en la base de datos`);
                    console.warn(`⚠️ Continuando sin guardado de mensajes en base de datos`);
                }
                else {
                    console.log(`✅ Mensajes guardados exitosamente en la base de datos. Role asignado: ${savedMessages.userRole}`);
                }
            }
            catch (saveError) {
                console.error(`❌ Error durante el proceso de guardado:`, saveError);
                console.warn(`⚠️ Continuando sin guardado de mensajes en base de datos debido a error: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
            }
            console.log(`🏁 Preparando respuesta final con o sin guardado de mensajes`);
            if (!effectiveDbUuid && !internalCommandId) {
                console.error(`💥 Error crítico: No se pudo obtener un ID de comando válido`);
                return NextResponse.json({
                    success: false,
                    error: {
                        code: 'COMMAND_ID_MISSING',
                        message: 'No se pudo obtener un ID de comando válido',
                        details: { internal_id: internalCommandId, db_uuid: effectiveDbUuid }
                    }
                }, { status: 500 });
            }
            if (!assistantMessage || assistantMessage === "No response generated") {
                console.error(`💥 Error crítico: No se generó una respuesta válida del asistente`);
                console.log(`Estado del comando: ${executedCommand?.status || 'desconocido'}`);
                console.log(`Resultados disponibles: ${executedCommand?.results ? JSON.stringify(executedCommand.results).substring(0, 200) : 'ninguno'}...`);
                assistantMessage = "Lo siento, estoy teniendo problemas para procesar tu solicitud en este momento. Por favor, inténtalo de nuevo.";
            }
            try {
                const responseData = {
                    success: true,
                    data: {
                        commandId: effectiveDbUuid || internalCommandId,
                        status: executedCommand?.status || 'completed_with_errors',
                        conversation_id: savedMessages?.conversationId || conversationId,
                        conversation_title: savedMessages?.conversationTitle || conversationTitle,
                        messages: {
                            user: {
                                content: message,
                                message_id: savedMessages?.userMessageId || null,
                                role: savedMessages?.userRole || 'user'
                            },
                            assistant: {
                                content: assistantMessage,
                                message_id: savedMessages?.assistantMessageId || null,
                                role: 'assistant'
                            }
                        },
                        ...(savedMessages?.partial ? { partial_save: true } : {})
                    }
                };
                console.log(`🚀 Enviando respuesta HTTP 200 con datos completos`);
                return NextResponse.json(responseData, { status: 200 });
            }
            catch (responseError) {
                console.error(`💥 Error crítico al construir la respuesta final:`, responseError);
                return NextResponse.json({
                    success: true,
                    data: {
                        commandId: effectiveDbUuid || internalCommandId,
                        messages: {
                            user: { content: message },
                            assistant: { content: assistantMessage || "Lo siento, ocurrió un error al procesar tu solicitud." }
                        },
                        error_info: "Error interno al construir la respuesta completa"
                    }
                }, { status: 200 });
            }
        }
        catch (error) {
            console.error(`❌ Error general en el procesamiento de la respuesta:`, error);
            return NextResponse.json({
                success: true,
                data: {
                    commandId: effectiveDbUuid || internalCommandId,
                    status: executedCommand?.status || 'completed_with_errors',
                    messages: {
                        user: {
                            content: message,
                        },
                        assistant: {
                            content: assistantMessage,
                            role: 'assistant'
                        }
                    },
                    error_details: {
                        message: `Se generó la respuesta pero ocurrió un error: ${error instanceof Error ? error.message : String(error)}`
                    }
                }
            }, { status: 200 });
        }
    }
    catch (error) {
        console.error('Error al procesar la solicitud:', error);
        return NextResponse.json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } }, { status: 500 });
    }
}
export async function POST(request: Request) { return withAuthorizedCommandRequest(request, handleCommandRequest); }
