import { withAuthorizedCommandRequest } from '@/lib/services/ai/command-http-routing';
import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { buildContentEditingContext, getContextSummary } from '@/lib/helpers/content-context-helper';
import { v4 as uuidv4 } from 'uuid';
import { isValidUUID, findContentCreatorAgent, commandService, getCommandDbUuid, waitForCommandCompletion, getContentById, updateContent, getAgentInfo } from './command-helpers-1';
async function handleCommandRequest(request: Request) {
    try {
        const body = await request.json();
        const { contentId, siteId, segmentId, campaignId, userId, agent_id, quickAction, styleControls, whatImGoodAt, topicsImInterestedIn, topicsToAvoid, aiPrompt } = body;
        console.log(`📨 Parámetros recibidos para content-editor: contentId=${contentId}, siteId=${siteId}, agentId=${agent_id}`);
        if (!contentId) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'contentId is required' } }, { status: 400 });
        }
        if (!siteId) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'siteId is required' } }, { status: 400 });
        }
        const originalContent = await getContentById(contentId);
        if (!originalContent) {
            return NextResponse.json({ success: false, error: { code: 'CONTENT_NOT_FOUND', message: 'The specified content does not exist' } }, { status: 404 });
        }
        const effectiveSegmentId = segmentId || originalContent.segment_id;
        const effectiveCampaignId = campaignId || originalContent.campaign_id;
        console.log(`🎯 IDs efectivos: segmentId=${effectiveSegmentId || 'N/A'}, campaignId=${effectiveCampaignId || 'N/A'}`);
        console.log(`📊 Fuente: segmentId=${segmentId ? 'request' : (originalContent.segment_id ? 'original' : 'N/A')}, campaignId=${campaignId ? 'request' : (originalContent.campaign_id ? 'original' : 'N/A')}`);
        let effectiveUserId = userId;
        let effectiveAgentId = agent_id;
        if (!effectiveAgentId) {
            const foundAgent = await findContentCreatorAgent(siteId);
            if (foundAgent) {
                effectiveAgentId = foundAgent.agentId;
                if (!effectiveUserId) {
                    effectiveUserId = foundAgent.userId;
                }
                console.log(`🤖 Usando agente con rol "Content Creator & Copywriter" encontrado: ${effectiveAgentId} (user_id: ${effectiveUserId})`);
            }
        }
        if (effectiveAgentId && !effectiveUserId) {
            const agentInfo = await getAgentInfo(effectiveAgentId);
            if (!agentInfo) {
                return NextResponse.json({ success: false, error: { code: 'AGENT_NOT_FOUND', message: 'The specified agent was not found' } }, { status: 404 });
            }
            effectiveUserId = agentInfo.user_id;
        }
        if (!effectiveUserId) {
            return NextResponse.json({ success: false, error: { code: 'INVALID_REQUEST', message: 'userId or agent_id is required' } }, { status: 400 });
        }
        const defaultStyleControls = {
            tone: "neutral",
            complexity: "moderate",
            creativity: "balanced",
            persuasiveness: "balanced",
            targetAudience: "mixed",
            engagement: "balanced",
            size: "medium"
        };
        const effectiveStyleControls = {
            ...defaultStyleControls,
            ...(styleControls || {})
        };
        const effectiveQuickAction = quickAction || 'improve';
        console.log(`👤 Usuario efectivo para el comando: ${effectiveUserId}`);
        console.log(`🎨 Controles de estilo: ${JSON.stringify(effectiveStyleControls)}`);
        console.log(`🚀 Acción rápida: ${effectiveQuickAction}`);
        console.log(`🔍 Construyendo contexto adicional: ${getContextSummary(effectiveSegmentId, effectiveCampaignId)}`);
        const additionalContext = await buildContentEditingContext(effectiveSegmentId, effectiveCampaignId);
        let contextMessage = `Edit the following content based on the specified parameters:

I need you to produce exceptional quality content that fully addresses the request. Please:

1. Maintain the requested tone and voice while enhancing clarity and engagement
2. Keep the content concise but comprehensive, focusing on delivering maximum value 
3. Ensure proper structure with clear sections, natural transitions, and logical flow
4. Optimize for both human readability and SEO where appropriate
5. Address all specified requirements and parameters in detail
6. Be creative while remaining factually accurate and authoritative

Original content to edit:
`;
        contextMessage += `Original Content:\nTitle: ${originalContent.title || 'No title'}\nDescription: ${originalContent.description || 'No description'}\nText: ${originalContent.text || 'No text'}\nType: ${originalContent.type || 'No type'}\n\n`;
        contextMessage += `Quick Action: ${effectiveQuickAction}\n`;
        contextMessage += `Style Controls:\n`;
        for (const [key, value] of Object.entries(effectiveStyleControls)) {
            contextMessage += `${key}: ${value}\n`;
        }
        contextMessage += `\n`;
        if (whatImGoodAt || topicsImInterestedIn || topicsToAvoid || aiPrompt) {
            contextMessage += `User Preferences:\n`;
            if (whatImGoodAt)
                contextMessage += `What I'm Good At: ${whatImGoodAt}\n`;
            if (topicsImInterestedIn)
                contextMessage += `Topics I'm Interested In: ${topicsImInterestedIn}\n`;
            if (topicsToAvoid)
                contextMessage += `Topics to Avoid: ${topicsToAvoid}\n`;
            if (aiPrompt)
                contextMessage += `Custom Instructions: ${aiPrompt}\n`;
            contextMessage += `\n`;
        }
        if (additionalContext) {
            contextMessage += `${additionalContext}\n\n`;
        }
        if (effectiveSegmentId)
            contextMessage += `Segment ID: ${effectiveSegmentId}\n`;
        if (effectiveCampaignId)
            contextMessage += `Campaign ID: ${effectiveCampaignId}\n`;
        contextMessage += `Site ID: ${siteId}\n`;
        contextMessage += `\nPlease format your response as a JSON object with the following structure:
{
  "title": "Edited title",
  "description": "Edited description",
  "text": "Edited content text"
}
`;
        contextMessage += `\n\nExact content values in JSON format for easier processing:
{
  "title": "${originalContent.title?.replace(/"/g, '\\"') || ''}",
  "description": "${originalContent.description?.replace(/"/g, '\\"') || ''}",
  "text": "${originalContent.text?.replace(/"/g, '\\"')?.substring(0, 1000) || ''}${originalContent.text && originalContent.text.length > 1000 ? '...' : ''}",
  "type": "${originalContent.type?.replace(/"/g, '\\"') || ''}"
}
`;
        const command = CommandFactory.createCommand({
            task: 'edit content',
            userId: effectiveUserId,
            agentId: effectiveAgentId,
            agentRole: 'Content Creator & Copywriter',
            site_id: siteId,
            description: 'Edit the content according to the specified quick action and style controls, while considering the user preferences.',
            targets: [
                {
                    deep_thinking: "Write a deep thinking reasoning about the content to be edited",
                },
                {
                    content: {
                        title: "Improved title for the content",
                        description: "Summary of the content",
                        text: "Final copy with the best format for the content type, for blog entries alwyas use markdown",
                    }
                }
            ],
            context: contextMessage,
            supervisor: [
                {
                    agent_role: 'content_editor',
                    status: 'not_initialized'
                },
                {
                    agent_role: 'content_reviewer',
                    status: 'not_initialized'
                }
            ],
            modelType: 'openrouter'
        });
        console.log(`🤖 Usando agente para edición de contenido: ${effectiveAgentId || 'No disponible'}`);
        const internalCommandId = await commandService.submitCommand(command);
        console.log(`📝 Comando de edición de contenido creado con ID interno: ${internalCommandId}`);
        let initialDbUuid = await getCommandDbUuid(internalCommandId);
        if (initialDbUuid) {
            console.log(`📌 UUID de base de datos obtenido inicialmente: ${initialDbUuid}`);
        }
        const { command: executedCommand, dbUuid, completed } = await waitForCommandCompletion(internalCommandId);
        const effectiveDbUuid = (dbUuid && isValidUUID(dbUuid)) ? dbUuid : initialDbUuid;
        if (!completed || !executedCommand) {
            return NextResponse.json({
                success: false,
                error: {
                    code: 'COMMAND_EXECUTION_FAILED',
                    message: 'The command did not complete successfully in the expected time'
                },
                command_id: effectiveDbUuid || internalCommandId,
                status: executedCommand?.status || 'unknown'
            }, { status: 500 });
        }
        let editedContent = {
            title: originalContent.title,
            description: originalContent.description,
            text: originalContent.text,
            type: originalContent.type
        };
        if (executedCommand.results && Array.isArray(executedCommand.results)) {
            console.log(`Resultados encontrados: ${JSON.stringify(executedCommand.results).substring(0, 200)}...`);
            const contentResults = executedCommand.results.find((r: any) => r.content && (r.content.title || r.content.description || r.content.text));
            if (contentResults && contentResults.content) {
                if (contentResults.content.title)
                    editedContent.title = contentResults.content.title;
                if (contentResults.content.description)
                    editedContent.description = contentResults.content.description;
                if (contentResults.content.text)
                    editedContent.text = contentResults.content.text;
                if (contentResults.content.type)
                    editedContent.type = contentResults.content.type;
                console.log(`✅ Contenido editado extraído: ${editedContent.title}`);
            }
            else {
                let foundContent = false;
                for (const result of executedCommand.results) {
                    if (result.type === 'content' && result.content) {
                        if (result.content.title)
                            editedContent.title = result.content.title;
                        if (result.content.description)
                            editedContent.description = result.content.description;
                        if (result.content.text)
                            editedContent.text = result.content.text;
                        if (result.content.type)
                            editedContent.type = result.content.type;
                        console.log(`✅ Contenido editado extraído (tipo alternativo): ${editedContent.title}`);
                        foundContent = true;
                        break;
                    }
                }
                if (!foundContent) {
                    for (const result of executedCommand.results) {
                        if (result.title || result.description || result.text) {
                            if (result.title)
                                editedContent.title = result.title;
                            if (result.description)
                                editedContent.description = result.description;
                            if (result.text)
                                editedContent.text = result.text;
                            if (result.type)
                                editedContent.type = result.type;
                            console.log(`✅ Contenido editado extraído (formato JSON directo): ${editedContent.title}`);
                            foundContent = true;
                            break;
                        }
                    }
                }
                if (!foundContent) {
                    for (const result of executedCommand.results) {
                        if (result.text || result.content || result.response || result.result) {
                            const jsonStr = result.text || result.content || result.response || result.result;
                            if (typeof jsonStr === 'string') {
                                try {
                                    const parsedJson = JSON.parse(jsonStr);
                                    if (parsedJson.title || parsedJson.description || parsedJson.text) {
                                        if (parsedJson.title)
                                            editedContent.title = parsedJson.title;
                                        if (parsedJson.description)
                                            editedContent.description = parsedJson.description;
                                        if (parsedJson.text)
                                            editedContent.text = parsedJson.text;
                                        console.log(`✅ Contenido editado extraído (JSON parseado): ${editedContent.title}`);
                                        foundContent = true;
                                        break;
                                    }
                                }
                                catch (e) {
                                }
                            }
                        }
                    }
                }
            }
        }
        else {
            console.warn("⚠️ No se encontraron resultados en el comando ejecutado");
        }
        const savedToDatabase = await updateContent(contentId, {
            title: editedContent.title,
            description: editedContent.description,
            text: editedContent.text,
            updated_at: new Date().toISOString(),
            command_id: effectiveDbUuid || internalCommandId
        });
        return NextResponse.json({
            success: true,
            data: {
                command_id: effectiveDbUuid || internalCommandId,
                status: executedCommand.status,
                contentId,
                siteId,
                segmentId: effectiveSegmentId,
                campaignId: effectiveCampaignId,
                original_content: {
                    title: originalContent.title,
                    description: originalContent.description,
                    text: originalContent.text,
                    type: originalContent.type
                },
                edited_content: editedContent,
                applied_actions: {
                    quick_action: effectiveQuickAction,
                    style_controls: effectiveStyleControls
                },
                saved_to_database: savedToDatabase
            }
        }, { status: 200 });
    }
    catch (error) {
        console.error('Error al procesar la solicitud:', error);
        return NextResponse.json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing the request' } }, { status: 500 });
    }
}
export async function POST(request: Request) { return withAuthorizedCommandRequest(request, handleCommandRequest); }
