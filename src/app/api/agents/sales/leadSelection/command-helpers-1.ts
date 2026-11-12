import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { getLeadInfo, getLeadTasks, getLeadConversations, getPreviousInteractions } from '@/lib/helpers/lead-context-helper';

export function isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}
export async function getConvertedLeadsBySegment(siteId: string, limit: number = 5): Promise<Record<string, any[]>> {
    try {
        console.log(`📈 Obteniendo leads convertidos por segmento para sitio: ${siteId}`);
        const { data: convertedLeads, error } = await supabaseAdmin
            .from('leads')
            .select(`
        *,
        segments!inner(id, name, description),
        sales!left(*)
      `)
            .eq('site_id', siteId)
            .eq('status', 'converted')
            .not('segment_id', 'is', null)
            .not('attribution', 'is', null)
            .order('created_at', { ascending: false });
        if (error) {
            console.error('Error al obtener leads convertidos:', error);
            return {};
        }
        if (!convertedLeads || convertedLeads.length === 0) {
            console.log('⚠️ No se encontraron leads convertidos');
            return {};
        }
        const leadsBySegment: Record<string, any[]> = {};
        for (const lead of convertedLeads) {
            const segmentId = lead.segment_id;
            const segmentName = (lead.segments as any)?.[0]?.name || 'Unknown Segment';
            if (!leadsBySegment[segmentName]) {
                leadsBySegment[segmentName] = [];
            }
            if (leadsBySegment[segmentName].length < limit) {
                leadsBySegment[segmentName].push({
                    ...lead,
                    segment_name: segmentName
                });
            }
        }
        console.log(`✅ Encontrados leads convertidos en ${Object.keys(leadsBySegment).length} segmentos`);
        return leadsBySegment;
    }
    catch (error) {
        console.error('Error al obtener leads convertidos por segmento:', error);
        return {};
    }
}
export async function getLostLeadsBySegment(siteId: string, limit: number = 5): Promise<Record<string, any[]>> {
    try {
        console.log(`📉 Obteniendo leads perdidos por segmento para sitio: ${siteId}`);
        const { data: lostLeads, error } = await supabaseAdmin
            .from('leads')
            .select(`
        *,
        segments!inner(id, name, description)
      `)
            .eq('site_id', siteId)
            .eq('status', 'lost')
            .not('segment_id', 'is', null)
            .not('attribution', 'is', null)
            .order('created_at', { ascending: false });
        if (error) {
            console.error('Error al obtener leads perdidos:', error);
            return {};
        }
        if (!lostLeads || lostLeads.length === 0) {
            console.log('⚠️ No se encontraron leads perdidos');
            return {};
        }
        const leadsBySegment: Record<string, any[]> = {};
        for (const lead of lostLeads) {
            const segmentId = lead.segment_id;
            const segmentName = (lead.segments as any)?.[0]?.name || 'Unknown Segment';
            if (!leadsBySegment[segmentName]) {
                leadsBySegment[segmentName] = [];
            }
            if (leadsBySegment[segmentName].length < limit) {
                leadsBySegment[segmentName].push({
                    ...lead,
                    segment_name: segmentName
                });
            }
        }
        console.log(`✅ Encontrados leads perdidos en ${Object.keys(leadsBySegment).length} segmentos`);
        return leadsBySegment;
    }
    catch (error) {
        console.error('Error al obtener leads perdidos por segmento:', error);
        return {};
    }
}
export async function getTeamMemberAttributionsBySegment(siteId: string): Promise<Record<string, any>> {
    try {
        console.log(`📊 Calculando atribuciones de team members por segmento para sitio: ${siteId}`);
        const { data: convertedLeads, error } = await supabaseAdmin
            .from('leads')
            .select(`
        segment_id,
        assignee_id,
        attribution,
        segments!inner(id, name, description),
        sales!left(amount)
      `)
            .eq('site_id', siteId)
            .eq('status', 'converted')
            .not('assignee_id', 'is', null)
            .not('segment_id', 'is', null);
        if (error) {
            console.error('Error al obtener leads convertidos:', error);
            return {};
        }
        if (!convertedLeads || convertedLeads.length === 0) {
            console.log('⚠️ No se encontraron leads convertidos para calcular atribuciones');
            return {};
        }
        const segmentAttributions: Record<string, Record<string, any>> = {};
        for (const lead of convertedLeads) {
            const segmentName = (lead.segments as any)?.[0]?.name || 'Unknown Segment';
            const assigneeId = lead.assignee_id;
            if (!segmentAttributions[segmentName]) {
                segmentAttributions[segmentName] = {};
            }
            if (!segmentAttributions[segmentName][assigneeId]) {
                segmentAttributions[segmentName][assigneeId] = {
                    assignee_id: assigneeId,
                    conversions: 0,
                    total_sales: 0,
                    attribution_data: []
                };
            }
            segmentAttributions[segmentName][assigneeId].conversions += 1;
            if (lead.sales && Array.isArray(lead.sales) && lead.sales.length > 0) {
                const totalSalesAmount = lead.sales.reduce((sum: number, sale: any) => sum + (sale.amount || 0), 0);
                segmentAttributions[segmentName][assigneeId].total_sales += totalSalesAmount;
            }
            if (lead.attribution) {
                segmentAttributions[segmentName][assigneeId].attribution_data.push(lead.attribution);
            }
        }
        const bestAssigneeBySegment: Record<string, any> = {};
        for (const [segmentName, assignees] of Object.entries(segmentAttributions)) {
            let bestAssignee = null;
            let maxScore = 0;
            for (const assigneeData of Object.values(assignees)) {
                const score = (assigneeData as any).conversions * 10 + ((assigneeData as any).total_sales / 1000);
                if (score > maxScore) {
                    maxScore = score;
                    bestAssignee = assigneeData;
                }
            }
            if (bestAssignee) {
                bestAssigneeBySegment[segmentName] = {
                    ...bestAssignee,
                    score: maxScore
                };
            }
        }
        for (const [segmentName, assigneeData] of Object.entries(bestAssigneeBySegment)) {
            try {
                const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(assigneeData.assignee_id);
                if (!userError && userData.user) {
                    assigneeData.name = userData.user.user_metadata?.name || userData.user.user_metadata?.full_name || userData.user.email;
                    assigneeData.email = userData.user.email;
                }
            }
            catch (userError) {
                console.warn(`Error obteniendo info del usuario ${assigneeData.assignee_id}:`, userError);
            }
        }
        console.log(`✅ Calculadas atribuciones para ${Object.keys(bestAssigneeBySegment).length} segmentos`);
        return bestAssigneeBySegment;
    }
    catch (error) {
        console.error('Error al obtener atribuciones de team members por segmento:', error);
        return {};
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
        return null;
    }
    catch (error) {
        console.error('Error al obtener UUID de base de datos:', error);
        return null;
    }
}
export async function findActiveAgentByRole(siteId: string, role: string): Promise<{
    agentId: string;
    userId: string;
} | null> {
    try {
        if (!siteId || !isValidUUID(siteId)) {
            console.error(`❌ Invalid site_id for agent search: ${siteId}`);
            return null;
        }
        console.log(`🔍 Buscando agente activo con role "${role}" para el sitio: ${siteId}`);
        const { data, error } = await supabaseAdmin
            .from('agents')
            .select('id, user_id')
            .eq('site_id', siteId)
            .eq('role', role)
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(1);
        if (error) {
            console.error(`Error al buscar agente con role "${role}":`, error);
            return null;
        }
        if (!data || data.length === 0) {
            console.log(`⚠️ No active agent found with role "${role}" for site: ${siteId}`);
            return null;
        }
        console.log(`✅ Agente con role "${role}" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
        return {
            agentId: data[0].id,
            userId: data[0].user_id
        };
    }
    catch (error) {
        console.error(`Error al buscar agente con role "${role}":`, error);
        return null;
    }
}
export async function findActiveSalesAgent(siteId: string): Promise<{
    agentId: string;
    userId: string;
} | null> {
    return await findActiveAgentByRole(siteId, 'Sales/CRM Specialist');
}
