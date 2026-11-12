import { consolidateSearchMemories, formatSearchMemoryAttribution } from '@/lib/services/analysis/search-memory-data';
import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { waitForSubmittedCommand } from '@/lib/agentbase/services/command/waitForSubmittedCommand';
import { v4 as uuidv4 } from 'uuid';
import { reportTool } from '@/app/api/agents/tools/report/assistantProtocol';

export const maxDuration = 300;
export function isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}
export async function findDataAnalystAgent(siteId: string): Promise<{
    agentId: string;
    userId: string;
} | null> {
    try {
        if (!siteId || !isValidUUID(siteId)) {
            console.error(`❌ Invalid site_id for Data Analyst agent search: ${siteId}`);
            return null;
        }
        const { data, error } = await supabaseAdmin
            .from('agents')
            .select('id, user_id')
            .eq('site_id', siteId)
            .eq('role', 'Data Analyst')
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(1);
        if (error) {
            console.error('Error al buscar agente con role "Data Analyst":', error);
            return null;
        }
        if (!data || data.length === 0) {
            console.log(`⚠️ No se encontró ningún agente con role "Data Analyst" activo para el sitio: ${siteId}`);
            return null;
        }
        return {
            agentId: data[0].id,
            userId: data[0].user_id
        };
    }
    catch (error) {
        console.error('Error al buscar agente Data Analyst:', error);
        return null;
    }
}
export async function getAgentSearchMemories(agentId: string, timeRange?: {
    from?: string;
    to?: string;
}, limit: number = 50, commandId?: string): Promise<{
    success: boolean;
    memories?: any[];
    error?: string;
}> {
    try {
        console.log(`🧠 Obteniendo memorias de búsqueda para agente: ${agentId}${commandId ? ` y comando: ${commandId}` : ''}`);
        let query = supabaseAdmin
            .from('agent_memories')
            .select('*')
            .eq('agent_id', agentId)
            .eq('type', 'search_results')
            .order('created_at', { ascending: false })
            .limit(limit);
        if (commandId) {
            if (isValidUUID(commandId)) {
                query = query.eq('command_id', commandId);
            }
            else {
                console.log(`⚠️ command_id '${commandId}' no es un UUID válido, buscando por original_command_id en data/metadata`);
                console.log(`⚠️ Filtrando memorias localmente por original_command_id: ${commandId}`);
            }
        }
        if (timeRange?.from) {
            query = query.gte('created_at', timeRange.from);
        }
        if (timeRange?.to) {
            query = query.lte('created_at', timeRange.to);
        }
        const { data, error } = await query;
        if (error) {
            console.error('❌ Error obteniendo memorias del agente:', error);
            return {
                success: false,
                error: error.message
            };
        }
        let filteredData = data || [];
        if (commandId && !isValidUUID(commandId)) {
            filteredData = (data || []).filter(memory => {
                const dataObj = memory.data || {};
                const metadataObj = memory.metadata || {};
                return dataObj.original_command_id === commandId || metadataObj.original_command_id === commandId;
            });
            console.log(`🔍 Filtrado local: ${filteredData.length} memorias encontradas con original_command_id: ${commandId}`);
        }
        console.log(`✅ Encontradas ${filteredData.length} memorias de búsqueda`);
        return {
            success: true,
            memories: filteredData
        };
    }
    catch (error) {
        console.error('❌ Error en getAgentSearchMemories:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred'
        };
    }
}
export const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
export const commandService = processorInitializer.getCommandService();
