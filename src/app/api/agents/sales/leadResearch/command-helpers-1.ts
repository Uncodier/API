import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { getLeadInfo, getPreviousInteractions, buildEnrichedContext, safeStringify } from '@/lib/helpers/lead-context-helper';

export function isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
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
                const hasResults = executedCommand.results && executedCommand.results.length > 0;
                const commandFinished = executedCommand.status === 'completed' ||
                    (executedCommand.status === 'failed' && hasResults);
                if (commandFinished) {
                    console.log(`✅ Comando ${commandId} terminado con estado: ${executedCommand.status}${hasResults ? ' (con resultados)' : ''}`);
                    if (!dbUuid || !isValidUUID(dbUuid)) {
                        dbUuid = await getCommandDbUuid(commandId);
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
                        dbUuid = await getCommandDbUuid(commandId);
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
export async function getAgentInfo(agentId: string): Promise<{
    user_id: string;
    site_id?: string;
    tools?: any[];
    activities?: any[];
} | null> {
    try {
        if (!isValidUUID(agentId)) {
            console.error(`ID de agente no válido: ${agentId}`);
            return null;
        }
        console.log(`🔍 Obteniendo información del agente: ${agentId}`);
        const { data, error } = await supabaseAdmin
            .from('agents')
            .select('id, user_id, site_id, configuration')
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
        let config = data.configuration;
        if (typeof config === 'string') {
            try {
                config = JSON.parse(config);
            }
            catch (e) {
                console.error('Error parsing agent configuration:', e);
                config = {};
            }
        }
        config = config || {};
        return {
            user_id: data.user_id,
            site_id: data.site_id,
            tools: config.tools || [],
            activities: config.activities || []
        };
    }
    catch (error) {
        console.error('Error al obtener información del agente:', error);
        return null;
    }
}
