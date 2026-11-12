import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { getCommerceReservationsPolicy } from '@/app/api/agents/customerSupport/support-policies';
import { buildChatMessageTools } from './tools';

export function isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}
export const ANONYMOUS_USER_ID = "00000000-0000-0000-0000-000000000000";
export async function getCommandDbUuid(internalId: string, commandService: any): Promise<string | null> {
    try {
        const command = await commandService.getCommandById(internalId);
        if (command && command.metadata && command.metadata.dbUuid) {
            if (isValidUUID(command.metadata.dbUuid)) {
                console.log(`🔑 UUID encontrado en metadata: ${command.metadata.dbUuid}`);
                return command.metadata.dbUuid;
            }
        }
        try {
            const idMap = (commandService as any).idTranslationMap;
            if (idMap && idMap.get && idMap.get(internalId)) {
                const mappedId = idMap.get(internalId);
                if (isValidUUID(mappedId)) {
                    console.log(`🔑 UUID encontrado en mapa interno: ${mappedId}`);
                    return mappedId;
                }
            }
        }
        catch (err) {
            console.log('No se pudo acceder al mapa de traducción interno');
        }
        if (command) {
            const { data, error } = await supabaseAdmin
                .from('commands')
                .select('id')
                .eq('task', command.task)
                .eq('user_id', command.user_id)
                .eq('status', command.status)
                .order('created_at', { ascending: false })
                .limit(1);
            if (!error && data && data.length > 0) {
                console.log(`🔑 UUID encontrado en búsqueda directa: ${data[0].id}`);
                return data[0].id;
            }
        }
        return null;
    }
    catch (error) {
        console.error('Error al obtener UUID de base de datos:', error);
        return null;
    }
}
export async function waitForCommandCompletion(commandId: string, commandService: any, maxAttempts = 100, delayMs = 1000) {
    let executedCommand = null;
    let attempts = 0;
    let dbUuid: string | null = null;
    console.log(`⏳ Esperando a que se complete el comando ${commandId}...`);
    return new Promise<{
        command: any;
        dbUuid: string | null;
        completed: boolean;
    }>((resolve) => {
        const checkInterval = setInterval(async () => {
            attempts++;
            try {
                executedCommand = await commandService.getCommandById(commandId);
                if (!executedCommand) {
                    console.log(`⚠️ No se pudo encontrar el comando ${commandId}`);
                    clearInterval(checkInterval);
                    resolve({ command: null, dbUuid: null, completed: false });
                    return;
                }
                if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
                    dbUuid = executedCommand.metadata.dbUuid as string;
                    console.log(`🔑 UUID de base de datos encontrado en metadata: ${dbUuid}`);
                }
                const hasResults = executedCommand.results && executedCommand.results.length > 0;
                const commandFinished = executedCommand.status === 'completed' ||
                    (executedCommand.status === 'failed' && hasResults);
                if (commandFinished) {
                    console.log(`✅ Comando ${commandId} terminado con estado: ${executedCommand.status}${hasResults ? ' (con resultados)' : ''}`);
                    if (!dbUuid || !isValidUUID(dbUuid)) {
                        dbUuid = await getCommandDbUuid(commandId, commandService);
                        console.log(`🔍 UUID obtenido después de completar: ${dbUuid || 'No encontrado'}`);
                    }
                    clearInterval(checkInterval);
                    const effectivelyCompleted = executedCommand.status === 'completed' ||
                        (executedCommand.status === 'failed' && hasResults);
                    resolve({ command: executedCommand, dbUuid, completed: effectivelyCompleted });
                    return;
                }
                console.log(`⏳ Comando ${commandId} aún en ejecución (estado: ${executedCommand.status}), intento ${attempts}/${maxAttempts}`);
                if (attempts >= maxAttempts) {
                    console.log(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
                    if (!dbUuid || !isValidUUID(dbUuid)) {
                        dbUuid = await getCommandDbUuid(commandId, commandService);
                        console.log(`🔍 UUID obtenido antes de timeout: ${dbUuid || 'No encontrado'}`);
                    }
                    clearInterval(checkInterval);
                    const usableResults = executedCommand.results && executedCommand.results.length > 0;
                    resolve({ command: executedCommand, dbUuid, completed: usableResults });
                }
            }
            catch (error) {
                console.error(`Error al verificar estado del comando ${commandId}:`, error);
                clearInterval(checkInterval);
                resolve({ command: null, dbUuid: null, completed: false });
            }
        }, delayMs);
    });
}
export async function saveMessages(userId: string, userMessage: string, assistantMessage: string, conversationId?: string, leadId?: string, visitorId?: string, conversationTitle?: string, agentId?: string, teamMemberId?: string, commandId?: string, channel?: string) {
    try {
        console.log(`📥 saveMessages recibió: userId=${userId}, teamMemberId=${teamMemberId || 'undefined'}, commandId=${commandId || 'undefined'}`);
        const effectiveRole = visitorId ? 'visitor' : (teamMemberId ? 'team_member' : 'user');
        console.log(`💾 Guardando mensajes - Role: ${effectiveRole}, User: ${teamMemberId || userId}`);
        if (!userId) {
            console.error('💥 Error: userId es requerido pero no fue proporcionado');
            return null;
        }
        if (!userMessage) {
            console.error('💥 Error: userMessage es requerido pero no fue proporcionado');
            return null;
        }
        if (!assistantMessage) {
            console.error('💥 Error: assistantMessage es requerido pero no fue proporcionado');
            return null;
        }
        if (!conversationId) {
            const conversationData: any = { user_id: userId };
            if (leadId)
                conversationData.lead_id = leadId;
            if (visitorId)
                conversationData.visitor_id = visitorId;
            if (agentId)
                conversationData.agent_id = agentId;
            if (conversationTitle)
                conversationData.title = conversationTitle;
            if (channel)
                conversationData.channel = channel;
            console.log(`🗣️ Creando nueva conversación con datos: ${JSON.stringify(conversationData).substring(0, 100)}...`);
            try {
                const { data: conversation, error: convError } = await supabaseAdmin
                    .from('conversations')
                    .insert([conversationData])
                    .select()
                    .single();
                if (convError) {
                    console.error('Error al crear conversación:', convError);
                    return null;
                }
                if (!conversation || !conversation.id) {
                    console.error('Error: No se pudo obtener el ID de la conversación creada');
                    return null;
                }
                conversationId = conversation.id;
                console.log(`🗣️ Nueva conversación creada con ID: ${conversationId}`);
                if (conversation.site_id) {
                    const { fireWorkflowDispatch } = await import('@/lib/services/workflow-robot/dispatch');
                    fireWorkflowDispatch({
                        table: 'conversations',
                        op: 'insert',
                        row: conversation as Record<string, unknown>,
                        site_id: conversation.site_id,
                    });
                }
            }
            catch (createConvError) {
                console.error('Error al crear conversación (excepción):', createConvError);
                return null;
            }
        }
        else if (conversationTitle) {
            console.log(`✏️ Actualizando título de conversación ${conversationId} a: "${conversationTitle}"`);
            try {
                const { error: updateError } = await supabaseAdmin
                    .from('conversations')
                    .update({ title: conversationTitle })
                    .eq('id', conversationId);
                if (updateError) {
                    console.error('Error al actualizar título de conversación:', updateError);
                    console.log('Continuando con el guardado de mensajes...');
                }
                else {
                    console.log(`✏️ Título de conversación actualizado: "${conversationTitle}"`);
                }
            }
            catch (updateTitleError) {
                console.error('Error al actualizar título (excepción):', updateTitleError);
                console.log('Continuando con el guardado de mensajes...');
            }
        }
        if (!conversationId) {
            console.error('💥 Error crítico: No se pudo obtener un ID de conversación válido');
            return null;
        }
        if (!isValidUUID(conversationId)) {
            console.error(`💥 Error crítico: ID de conversación no es un UUID válido: ${conversationId}`);
            return null;
        }
        const messages = [];
        try {
            console.log(`💬 Preparando guardado del mensaje del usuario en conversación: ${conversationId}`);
            const userMessageData: any = {
                conversation_id: conversationId,
                user_id: teamMemberId || userId,
                content: userMessage,
                role: teamMemberId ? "team_member" : "user"
            };
            console.log(`📋 Datos del mensaje del usuario: user_id=${userMessageData.user_id}, role=${userMessageData.role}`);
            if (leadId)
                userMessageData.lead_id = leadId;
            if (visitorId)
                userMessageData.visitor_id = visitorId;
            if (agentId)
                userMessageData.agent_id = agentId;
            if (commandId)
                userMessageData.command_id = commandId;
            const { data: savedUserMessage, error: userMsgError } = await supabaseAdmin
                .from('messages')
                .insert([userMessageData])
                .select()
                .single();
            if (userMsgError) {
                console.error('Error al guardar mensaje del usuario:', userMsgError);
                return null;
            }
            if (!savedUserMessage || !savedUserMessage.id) {
                console.error('Error: No se pudo obtener el ID del mensaje del usuario guardado');
                return null;
            }
            console.log(`💾 Mensaje del usuario guardado con ID: ${savedUserMessage.id}`);
            messages.push(savedUserMessage);
            console.log(`💬 Preparando guardado del mensaje del asistente en conversación: ${conversationId}`);
            const assistantMessageData: any = {
                conversation_id: conversationId,
                content: assistantMessage,
                role: 'assistant'
            };
            if (leadId)
                assistantMessageData.lead_id = leadId;
            if (visitorId)
                assistantMessageData.visitor_id = visitorId;
            if (agentId)
                assistantMessageData.agent_id = agentId;
            if (commandId)
                assistantMessageData.command_id = commandId;
            const { data: savedAssistantMessage, error: assistantMsgError } = await supabaseAdmin
                .from('messages')
                .insert([assistantMessageData])
                .select()
                .single();
            if (assistantMsgError) {
                console.error('Error al guardar mensaje del asistente:', assistantMsgError);
                return null;
            }
            if (!savedAssistantMessage || !savedAssistantMessage.id) {
                console.error('Error: No se pudo obtener el ID del mensaje del asistente guardado');
                return null;
            }
            console.log(`💾 Mensaje del asistente guardado con ID: ${savedAssistantMessage.id}`);
            messages.push(savedAssistantMessage);
            console.log(`✅ Ambos mensajes guardados exitosamente para la conversación: ${conversationId}`);
            return {
                conversationId,
                userMessageId: savedUserMessage.id,
                assistantMessageId: savedAssistantMessage.id,
                conversationTitle,
                userRole: effectiveRole
            };
        }
        catch (saveMessagesError) {
            console.error('Error al guardar mensajes en la base de datos (excepción):', saveMessagesError);
            if (messages.length > 0) {
                const userMsg = messages.find(m => m.role === 'user');
                const assistantMsg = messages.find(m => m.role === 'assistant');
                return {
                    conversationId,
                    userMessageId: userMsg?.id || null,
                    assistantMessageId: assistantMsg?.id || null,
                    conversationTitle,
                    userRole: effectiveRole,
                    partial: true
                };
            }
            return null;
        }
    }
    catch (error) {
        console.error('Error general al guardar mensajes en la base de datos:', error);
        return null;
    }
}
