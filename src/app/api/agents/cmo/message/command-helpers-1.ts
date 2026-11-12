import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { commandTools } from './command-tools';

export function isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}
export async function findActiveCmoAgent(siteId: string): Promise<{
    agentId: string;
    userId: string;
} | null> {
    try {
        if (!siteId || !isValidUUID(siteId)) {
            console.error(`❌ Invalid site_id for agent search: ${siteId}`);
            return null;
        }
        console.log(`🔍 Buscando agente de CMO activo para el sitio: ${siteId}`);
        const { data, error } = await supabaseAdmin
            .from('agents')
            .select('id, user_id')
            .eq('site_id', siteId)
            .eq('role', 'CMO')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(1);
        if (error) {
            console.error('Error al buscar agente de CMO:', error);
            return null;
        }
        if (!data || data.length === 0) {
            console.log(`⚠️ No se encontró ningún agente de CMO activo para el sitio: ${siteId}`);
            return null;
        }
        console.log(`✅ Agente de CMO encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
        return {
            agentId: data[0].id,
            userId: data[0].user_id
        };
    }
    catch (error) {
        console.error('Error al buscar agente de CMO:', error);
        return null;
    }
}
export async function getAgentInfo(agentId: string): Promise<{
    user_id: string;
    site_id?: string;
} | null> {
    try {
        if (!isValidUUID(agentId)) {
            console.error(`ID de agente no válido: ${agentId}`);
            return null;
        }
        console.log(`🔍 Obteniendo información del agente: ${agentId}`);
        const { data, error } = await supabaseAdmin
            .from('agents')
            .select('id, user_id, site_id')
            .eq('id', agentId)
            .single();
        if (error) {
            console.error('Error al obtener información del agente:', error);
            return null;
        }
        if (!data) {
            console.log(`⚠️ No se encontró el agente con ID: ${agentId}`);
            return null;
        }
        console.log(`✅ Información del agente recuperada: user_id=${data.user_id}, site_id=${data.site_id || 'N/A'}`);
        return {
            user_id: data.user_id,
            site_id: data.site_id
        };
    }
    catch (error) {
        console.error('Error al obtener información del agente:', error);
        return null;
    }
}
export const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
export const commandService = processorInitializer.getCommandService();
export async function getCommandDbUuid(internalId: string): Promise<string | null> {
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
export async function waitForCommandCompletion(commandId: string, maxAttempts = 100, delayMs = 1000) {
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
                if (executedCommand.status === 'completed' || executedCommand.status === 'failed') {
                    console.log(`✅ Comando ${commandId} completado con estado: ${executedCommand.status}`);
                    if (!dbUuid || !isValidUUID(dbUuid)) {
                        dbUuid = await getCommandDbUuid(commandId);
                        console.log(`🔍 UUID obtenido después de completar: ${dbUuid || 'No encontrado'}`);
                    }
                    clearInterval(checkInterval);
                    resolve({ command: executedCommand, dbUuid, completed: executedCommand.status === 'completed' });
                    return;
                }
                console.log(`⏳ Comando ${commandId} aún en ejecución (estado: ${executedCommand.status}), intento ${attempts}/${maxAttempts}`);
                if (attempts >= maxAttempts) {
                    console.log(`⏰ Tiempo de espera agotado para el comando ${commandId}`);
                    if (!dbUuid || !isValidUUID(dbUuid)) {
                        dbUuid = await getCommandDbUuid(commandId);
                        console.log(`🔍 UUID obtenido antes de timeout: ${dbUuid || 'No encontrado'}`);
                    }
                    clearInterval(checkInterval);
                    resolve({ command: executedCommand, dbUuid, completed: false });
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
export async function saveMessages(userId: string, userMessage: string, assistantMessage: string, conversationId?: string, conversationTitle?: string, leadId?: string, visitorId?: string, agentId?: string, siteId?: string, commandId?: string) {
    try {
        console.log(`💾 Guardando mensajes con: user_id=${userId}, agent_id=${agentId || 'N/A'}, site_id=${siteId || 'N/A'}, lead_id=${leadId || 'N/A'}, visitor_id=${visitorId || 'N/A'}, command_id=${commandId || 'N/A'}`);
        let effectiveConversationId: string | undefined = conversationId;
        if (conversationId) {
            console.log(`🔍 Verificando existencia de conversación: ${conversationId}`);
            const { data: existingConversation, error: checkError } = await supabaseAdmin
                .from('conversations')
                .select('id, user_id, lead_id, visitor_id, agent_id, site_id')
                .eq('id', conversationId)
                .single();
            if (checkError || !existingConversation) {
                console.log(`⚠️ Conversación no encontrada en la base de datos, creando nueva: ${conversationId}`);
                effectiveConversationId = undefined;
            }
            else {
                console.log(`✅ Conversación existente confirmada: ${conversationId}`);
                console.log(`📊 Datos de conversación existente:`, JSON.stringify(existingConversation));
            }
        }
        if (!effectiveConversationId) {
            const conversationData: any = {
                user_id: userId
            };
            if (visitorId)
                conversationData.visitor_id = visitorId;
            if (agentId)
                conversationData.agent_id = agentId;
            if (siteId)
                conversationData.site_id = siteId;
            if (leadId && !agentId) {
                conversationData.lead_id = leadId;
                console.log(`⚠️ Agregando lead_id a la conversación porque no hay agentId`);
            }
            if (conversationTitle)
                conversationData.title = conversationTitle;
            console.log(`🗣️ Creando nueva conversación con datos:`, JSON.stringify(conversationData));
            const { data: conversation, error: convError } = await supabaseAdmin
                .from('conversations')
                .insert([conversationData])
                .select()
                .single();
            if (convError) {
                console.error('Error al crear conversación:', convError);
                return null;
            }
            effectiveConversationId = conversation.id;
            console.log(`🗣️ Nueva conversación creada con ID: ${effectiveConversationId}`);
        }
        else if (conversationTitle || siteId) {
            const updateData: any = {};
            if (conversationTitle)
                updateData.title = conversationTitle;
            if (siteId)
                updateData.site_id = siteId;
            console.log(`✏️ Actualizando conversación: ${effectiveConversationId} con:`, JSON.stringify(updateData));
            const { error: updateError } = await supabaseAdmin
                .from('conversations')
                .update(updateData)
                .eq('id', effectiveConversationId);
            if (updateError) {
                console.error('Error al actualizar conversación:', updateError);
                console.log('Continuando con el guardado de mensajes...');
            }
            else {
                if (conversationTitle) {
                    console.log(`✏️ Título de conversación actualizado: "${conversationTitle}"`);
                }
                if (siteId) {
                    console.log(`🔗 Site ID de conversación actualizado: "${siteId}"`);
                }
            }
        }
        const userMessageObj: any = {
            conversation_id: effectiveConversationId,
            user_id: userId,
            content: userMessage,
            role: 'user'
        };
        if (visitorId)
            userMessageObj.visitor_id = visitorId;
        if (leadId && !agentId) {
            userMessageObj.lead_id = leadId;
        }
        if (agentId)
            userMessageObj.agent_id = agentId;
        if (commandId && isValidUUID(commandId)) {
            userMessageObj.command_id = commandId;
        }
        console.log(`💬 Guardando mensaje de usuario para conversación: ${effectiveConversationId}`);
        const { data: savedUserMessage, error: userMsgError } = await supabaseAdmin
            .from('messages')
            .insert([userMessageObj])
            .select()
            .single();
        if (userMsgError) {
            console.error('Error al guardar mensaje del usuario:', userMsgError);
            return null;
        }
        console.log(`💾 Mensaje del usuario guardado con ID: ${savedUserMessage.id}`);
        const assistantMessageObj: any = {
            conversation_id: effectiveConversationId,
            user_id: null,
            content: assistantMessage,
            role: 'assistant'
        };
        if (visitorId)
            assistantMessageObj.visitor_id = visitorId;
        if (leadId && !agentId) {
            assistantMessageObj.lead_id = leadId;
        }
        if (agentId)
            assistantMessageObj.agent_id = agentId;
        if (commandId && isValidUUID(commandId)) {
            assistantMessageObj.command_id = commandId;
        }
        console.log(`💬 Guardando mensaje de asistente para conversación: ${effectiveConversationId}`);
        const { data: savedAssistantMessage, error: assistantMsgError } = await supabaseAdmin
            .from('messages')
            .insert([assistantMessageObj])
            .select()
            .single();
        if (assistantMsgError) {
            console.error('Error al guardar mensaje del asistente:', assistantMsgError);
            return null;
        }
        console.log(`💾 Mensaje del asistente guardado con ID: ${savedAssistantMessage.id}`);
        const { data: finalConversation, error: finalCheckError } = await supabaseAdmin
            .from('conversations')
            .select('id, user_id, lead_id, visitor_id, agent_id, site_id, title')
            .eq('id', effectiveConversationId)
            .single();
        if (!finalCheckError && finalConversation) {
            console.log(`✅ Verificación final de conversación: ${JSON.stringify(finalConversation)}`);
        }
        else {
            console.error(`❌ Error al verificar conversación final:`, finalCheckError);
        }
        return {
            conversationId: effectiveConversationId,
            userMessageId: savedUserMessage.id,
            assistantMessageId: savedAssistantMessage.id,
            conversationTitle
        };
    }
    catch (error) {
        console.error('Error al guardar mensajes en la base de datos:', error);
        return null;
    }
}
