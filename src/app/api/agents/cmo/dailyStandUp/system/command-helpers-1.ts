import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

export function isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}
export async function saveToAgentMemory(agentId: string, userId: string, commandId: string, analysisData: any, siteId: string): Promise<{
    success: boolean;
    memoryId?: string;
    error?: string;
}> {
    try {
        const memoryId = uuidv4();
        const memoryKey = `daily_standup_system_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const validCommandId = commandId && isValidUUID(commandId) ? commandId : null;
        const memoryData = {
            id: memoryId,
            agent_id: agentId,
            user_id: userId,
            command_id: validCommandId,
            type: 'daily_standup_system',
            key: memoryKey,
            data: {
                analysis_type: 'system_health_assessment',
                strategic_analysis: analysisData,
                timestamp: new Date().toISOString(),
                site_id: siteId,
                command_id: commandId,
                system_metrics: {
                    analysis_completed: true,
                    recommendations_generated: true,
                    health_status: analysisData?.health_status || 'analyzed'
                }
            },
            raw_data: JSON.stringify(analysisData),
            metadata: {
                source: 'daily_standup_system',
                analysis_type: 'cmo_system_analysis',
                importance: 'high',
                retention_policy: '7_days',
                original_command_id: commandId || null
            },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            access_count: 0,
            last_accessed: new Date().toISOString()
        };
        console.log(`💾 Guardando análisis del sistema en agent_memories para agente: ${agentId} (command_id: ${commandId})`);
        const { data, error } = await supabaseAdmin
            .from('agent_memories')
            .insert([memoryData])
            .select('id')
            .single();
        if (error) {
            console.error('❌ Error guardando en agent_memories:', error);
            return {
                success: false,
                error: error.message
            };
        }
        console.log(`✅ Memoria del sistema guardada con ID: ${data.id}`);
        return {
            success: true,
            memoryId: data.id
        };
    }
    catch (error) {
        console.error('❌ Error en saveToAgentMemory:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred'
        };
    }
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
            .eq('role', 'Growth Lead/Manager')
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
export async function getSystemData(siteId: string) {
    try {
        console.log(`📊 Obteniendo datos del sistema para site_id: ${siteId}`);
        const { data: siteConfig, error: siteError } = await supabaseAdmin
            .from('sites')
            .select('*')
            .eq('id', siteId)
            .single();
        if (siteError) {
            console.error('Error al obtener configuración del sitio:', siteError);
        }
        const { data: siteSettings, error: settingsError } = await supabaseAdmin
            .from('settings')
            .select('*')
            .eq('site_id', siteId)
            .order('created_at', { ascending: false });
        if (settingsError) {
            console.error('Error al obtener settings del sitio:', settingsError);
        }
        const { data: billingData, error: billingError } = await supabaseAdmin
            .from('billing')
            .select('*')
            .eq('site_id', siteId)
            .order('created_at', { ascending: false })
            .limit(1);
        if (billingError) {
            console.error('Error al obtener datos de billing:', billingError);
        }
        const { data: systemMetrics, error: metricsError } = await supabaseAdmin
            .from('session_events')
            .select('*')
            .eq('site_id', siteId)
            .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
            .order('created_at', { ascending: false });
        if (metricsError) {
            console.error('Error al obtener métricas del sistema:', metricsError);
        }
        return {
            siteConfig: siteConfig || null,
            siteSettings: siteSettings || [],
            billingData: billingData?.[0] || null,
            systemMetrics: systemMetrics || [],
            metricsCount: systemMetrics?.length || 0,
            settingsCount: siteSettings?.length || 0
        };
    }
    catch (error) {
        console.error('Error al obtener datos del sistema:', error);
        return null;
    }
}
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
export async function waitForCommandCompletion(commandService: any, commandId: string, maxAttempts = 100, delayMs = 1000) {
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
export const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
export const commandService = processorInitializer.getCommandService();
