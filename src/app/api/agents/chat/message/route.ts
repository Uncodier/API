import { authorizeChatTurn } from './authorize-turn';
import { enableMemberConversationGateway } from '@/lib/connectors/channel-member-host';
import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { extractSupportResults } from '@/app/api/agents/customerSupport/message/results';
import { isAssignedChannelCommand } from '@/lib/connectors/channel-command-row';
import { getCommerceReservationsPolicy } from '@/app/api/agents/customerSupport/support-policies';
import { buildChatMessageTools } from './tools';
import { isValidUUID, getCommandDbUuid, waitForCommandCompletion, saveMessages } from './command-helpers-1';
import { getConversationHistory, formatConversationHistoryForContext, getAgentInfo, getTeamMemberInfo } from './command-helpers-2';
async function handleCommandRequest(request: Request) {
    try {
        const turn = await authorizeChatTurn(request, await request.json());
        if (turn instanceof Response) return turn;
        const processorInitializer = ProcessorInitializer.getInstance();
        processorInitializer.initialize();
        const commandService = processorInitializer.getCommandService();
        const channel = 'web';
        const { conversationId, message, agentId, lead_id, visitor_id, site_id, team_member_id } = turn;
        const agentInfo = await getAgentInfo(agentId, site_id);
        if (!agentInfo) {
            return NextResponse.json({ success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } }, { status: 404 });
        }
        const userId = team_member_id;
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
        await enableMemberConversationGateway(request, command, conversationId, message);
        const internalCommandId = await commandService.submitCommand(command);
        console.log(`📝 Comando creado con ID interno: ${internalCommandId}`);
        let initialDbUuid = await getCommandDbUuid(internalCommandId, commandService);
        if (initialDbUuid) {
            console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
        }
        const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId, commandService);
        const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
        if (!completed || !effectiveDbUuid || executedCommand?.status !== 'completed' ||
            executedCommand.site_id !== site_id || executedCommand.agent_id !== agentId || executedCommand.user_id !== userId ||
            (executedCommand.metadata?.dbUuid ?? executedCommand.id) !== effectiveDbUuid ||
            !await isAssignedChannelCommand(effectiveDbUuid, site_id, agentId, userId)) {
            return NextResponse.json({success:false, error:{code:'CHAT_REPLY_UNCONFIRMED', message:'Agent reply could not be verified.'}}, {status:503});
        }
        const {assistantMessage, conversationTitle} = extractSupportResults(executedCommand);
        if (!assistantMessage) return NextResponse.json({success:false, error:{code:'CHAT_REPLY_MISSING', message:'Agent did not return a text reply.'}}, {status:503});
        const current = await authorizeChatTurn(request, turn);
        if (current instanceof Response) return current;
        if (current.lead_id !== lead_id || current.visitor_id !== visitor_id) {
            return NextResponse.json({success:false, error:{code:'CHAT_CHANGED', message:'The conversation has changed.'}}, {status:409});
        }
        const saved = await saveMessages(userId, message, assistantMessage, conversationId, lead_id, visitor_id, conversationTitle,
            agentId, team_member_id, effectiveDbUuid, channel);
        if (!saved?.assistantMessageId || !saved.userMessageId || saved.conversationId !== conversationId) {
            return NextResponse.json({success:false, error:{code:'CHAT_SAVE_UNCONFIRMED', message:'Message persistence could not be confirmed.'}}, {status:503});
        }
        return NextResponse.json({success:true, data:{commandId: effectiveDbUuid, status:'completed', conversation_id: conversationId,
            conversation_title: conversationTitle, messages:{user:{content:message,message_id:saved.userMessageId,role:saved.userRole},
            assistant:{content:assistantMessage,message_id:saved.assistantMessageId,role:'assistant'}}}});
    }
    catch (error) {
        console.error('Error al procesar la solicitud:', error);
        return NextResponse.json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } }, { status: 500 });
    }
}
export async function POST(request: Request) { return withAuthorizedCommandRequest(request, handleCommandRequest); }
