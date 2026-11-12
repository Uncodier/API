import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';

export function isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}
export async function findCopywriterAgent(siteId: string): Promise<{
    agentId: string;
    userId: string;
} | null> {
    try {
        if (!siteId || !isValidUUID(siteId)) {
            console.error(`❌ Invalid site_id for copywriter agent search: ${siteId}`);
            return null;
        }
        console.log(`🔍 Buscando agente con rol "copywriter" para el sitio: ${siteId}`);
        const { data, error } = await supabaseAdmin
            .from('agents')
            .select('id, user_id')
            .eq('site_id', siteId)
            .eq('status', 'active')
            .eq('role', 'Content Creator & Copywriter')
            .order('created_at', { ascending: false })
            .limit(1);
        if (error) {
            console.error('Error al buscar agente con rol "copywriter":', error);
            return null;
        }
        if (!data || data.length === 0) {
            console.log(`⚠️ No se encontró ningún agente con rol "copywriter" activo para el sitio: ${siteId}`);
            return null;
        }
        console.log(`✅ Agente con rol "copywriter" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
        return {
            agentId: data[0].id,
            userId: data[0].user_id
        };
    }
    catch (error) {
        console.error('Error al buscar agente copywriter:', error);
        return null;
    }
}
export async function getAgentInfo(agentId: string): Promise<{
    user_id: string;
    site_id?: string;
    tools?: any[];
} | null> {
    try {
        if (!isValidUUID(agentId)) {
            console.error(`❌ Invalid agentId: ${agentId}`);
            return null;
        }
        console.log(`🔍 Obteniendo información del agente: ${agentId}`);
        const { data, error } = await supabaseAdmin
            .from('agents')
            .select('user_id, site_id, tools')
            .eq('id', agentId)
            .single();
        if (error) {
            console.error('Error al obtener información del agente:', error);
            return null;
        }
        if (!data) {
            console.log(`⚠️ No se encontró agente con ID: ${agentId}`);
            return null;
        }
        console.log(`✅ Información del agente obtenida: user_id=${data.user_id}, site_id=${data.site_id}`);
        return data;
    }
    catch (error) {
        console.error('Error al obtener información del agente:', error);
        return null;
    }
}
export async function getContentById(contentId: string): Promise<any | null> {
    try {
        if (!isValidUUID(contentId)) {
            console.log(`Invalid content ID: ${contentId}`);
            return null;
        }
        const { data, error } = await supabaseAdmin
            .from('content')
            .select('*')
            .eq('id', contentId)
            .single();
        if (error) {
            console.error(`Error fetching content: ${error.message}`);
            return null;
        }
        return data;
    }
    catch (error) {
        console.error('Error getting content by ID:', error);
        return null;
    }
}
export async function getDraftContentForSite(siteId: string, segmentId?: string, campaignId?: string, contentIds?: string[], limit: number = 50): Promise<any[]> {
    try {
        if (!isValidUUID(siteId)) {
            console.log(`Invalid site ID: ${siteId}`);
            return [];
        }
        let query = supabaseAdmin
            .from('content')
            .select('*')
            .eq('site_id', siteId)
            .eq('status', 'draft')
            .order('created_at', { ascending: false })
            .limit(limit);
        if (segmentId && isValidUUID(segmentId)) {
            query = query.eq('segment_id', segmentId);
        }
        if (campaignId && isValidUUID(campaignId)) {
            query = query.eq('campaign_id', campaignId);
        }
        if (contentIds && contentIds.length > 0) {
            const validContentIds = contentIds.filter(id => isValidUUID(id));
            if (validContentIds.length > 0) {
                query = query.in('id', validContentIds);
            }
        }
        const { data, error } = await query;
        if (error) {
            console.error(`Error fetching draft content: ${error.message}`);
            return [];
        }
        return data || [];
    }
    catch (error) {
        console.error('Error getting draft content:', error);
        return [];
    }
}
export async function updateMultipleContentInDatabase(improvementResults: Array<{
    contentId: string;
    improvedContent: any;
}>, userId?: string): Promise<{
    updated: any[];
    failed: string[];
}> {
    const updated = [];
    const failed = [];
    for (const result of improvementResults) {
        try {
            const { contentId, improvedContent } = result;
            if (!isValidUUID(contentId)) {
                console.log(`Invalid content ID: ${contentId}`);
                failed.push(contentId);
                continue;
            }
            const updateData = {
                title: improvedContent.title || undefined,
                description: improvedContent.description || undefined,
                text: improvedContent.text || improvedContent.content || undefined,
                status: 'draft',
                updated_at: new Date().toISOString(),
                metadata: {
                    ...improvedContent.metadata,
                    improved_at: new Date().toISOString(),
                    improved_by: userId || 'system',
                    improvement_notes: improvedContent.improvement_notes || null,
                    original_score: improvedContent.original_score || null,
                    improved_score: improvedContent.improved_score || null,
                    improvements_applied: improvedContent.improvements_applied || []
                }
            };
            Object.keys(updateData).forEach(key => {
                if ((updateData as any)[key] === undefined) {
                    delete (updateData as any)[key];
                }
            });
            console.log(`Updating content ${contentId} with improved version:`);
            console.log(`  - Title: ${improvedContent.title ? improvedContent.title.substring(0, 50) + '...' : 'No title'}`);
            console.log(`  - Description: ${improvedContent.description ? improvedContent.description.substring(0, 50) + '...' : 'No description'}`);
            console.log(`  - Text length: ${improvedContent.text ? improvedContent.text.length : 0} characters`);
            const { data, error } = await supabaseAdmin
                .from('content')
                .update(updateData)
                .eq('id', contentId)
                .select()
                .single();
            if (error) {
                console.error(`Error updating content ${contentId}:`, error);
                failed.push(contentId);
            }
            else {
                console.log(`Successfully updated content ${contentId}`);
                updated.push(data);
            }
        }
        catch (error: any) {
            console.error(`Error updating content ${result.contentId}:`, error);
            failed.push(result.contentId);
        }
    }
    return { updated, failed };
}
export const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
export const commandService = processorInitializer.getCommandService();
export async function getCommandDbUuid(internalId: string): Promise<string | null> {
    try {
        const command = await commandService.getCommandById(internalId);
        if (command && command.metadata && command.metadata.dbUuid) {
            if (isValidUUID(command.metadata.dbUuid)) {
                console.log(`🔑 UUID found in metadata: ${command.metadata.dbUuid}`);
                return command.metadata.dbUuid;
            }
        }
        try {
            const idMap = (commandService as any).idTranslationMap;
            if (idMap && idMap.get && idMap.get(internalId)) {
                const mappedId = idMap.get(internalId);
                if (isValidUUID(mappedId)) {
                    console.log(`🔑 UUID found in internal map: ${mappedId}`);
                    return mappedId;
                }
            }
        }
        catch (err) {
            console.log('Could not access internal translation map');
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
                console.log(`🔑 UUID found in direct search: ${data[0].id}`);
                return data[0].id;
            }
        }
        return null;
    }
    catch (error) {
        console.error('Error getting database UUID:', error);
        return null;
    }
}
export async function waitForCommandCompletion(commandId: string, maxAttempts = 120, delayMs = 1000) {
    let executedCommand = null;
    let attempts = 0;
    let dbUuid: string | null = null;
    console.log(`⏳ Waiting for command ${commandId} to complete...`);
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
                    console.log(`⚠️ Could not find command ${commandId}`);
                    clearInterval(checkInterval);
                    resolve({ command: null, dbUuid: null, completed: false });
                    return;
                }
                if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
                    dbUuid = executedCommand.metadata.dbUuid as string;
                    console.log(`🔑 Database UUID found in metadata: ${dbUuid}`);
                }
                if (executedCommand.status === 'completed' || executedCommand.status === 'failed') {
                    console.log(`✅ Command ${commandId} completed with status: ${executedCommand.status}`);
                    if (!dbUuid || !isValidUUID(dbUuid)) {
                        dbUuid = await getCommandDbUuid(commandId);
                        console.log(`🔍 UUID obtained after completion: ${dbUuid || 'Not found'}`);
                    }
                    clearInterval(checkInterval);
                    resolve({ command: executedCommand, dbUuid, completed: executedCommand.status === 'completed' });
                    return;
                }
                console.log(`⏳ Command ${commandId} still running (status: ${executedCommand.status}), attempt ${attempts}/${maxAttempts}`);
                if (attempts >= maxAttempts) {
                    console.log(`⏰ Timeout for command ${commandId}`);
                    if (!dbUuid || !isValidUUID(dbUuid)) {
                        dbUuid = await getCommandDbUuid(commandId);
                        console.log(`🔍 UUID obtained before timeout: ${dbUuid || 'Not found'}`);
                    }
                    clearInterval(checkInterval);
                    resolve({ command: executedCommand, dbUuid, completed: false });
                }
            }
            catch (error) {
                console.error(`Error checking command status ${commandId}:`, error);
                clearInterval(checkInterval);
                resolve({ command: null, dbUuid: null, completed: false });
            }
        }, delayMs);
    });
}
export async function getSegmentInfo(segmentId: string): Promise<any | null> {
    try {
        if (!isValidUUID(segmentId)) {
            console.log(`Invalid segment ID: ${segmentId}`);
            return null;
        }
        const { data, error } = await supabaseAdmin
            .from('segments')
            .select('*')
            .eq('id', segmentId)
            .eq('is_active', true)
            .single();
        if (error) {
            console.error(`Error fetching segment info: ${error.message}`);
            return null;
        }
        return data;
    }
    catch (error) {
        console.error('Error getting segment info:', error);
        return null;
    }
}
