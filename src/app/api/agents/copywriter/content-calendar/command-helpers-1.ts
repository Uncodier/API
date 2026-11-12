import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getContentRequirementsContext } from '@/lib/helpers/content-requirements-helper';

export function isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}
export async function findContentCreatorAgent(siteId: string): Promise<{
    agentId: string;
    userId: string;
} | null> {
    try {
        if (!siteId || !isValidUUID(siteId)) {
            console.error(`❌ Invalid site_id for content creator agent search: ${siteId}`);
            return null;
        }
        console.log(`🔍 Buscando agente con rol "Content Creator & Copywriter" para el sitio: ${siteId}`);
        const { data, error } = await supabaseAdmin
            .from('agents')
            .select('id, user_id')
            .eq('site_id', siteId)
            .eq('status', 'active')
            .eq('role', 'Content Creator & Copywriter')
            .order('created_at', { ascending: false })
            .limit(1);
        if (error) {
            console.error('Error al buscar agente con rol "Content Creator & Copywriter":', error);
            return null;
        }
        if (!data || data.length === 0) {
            console.log(`⚠️ No se encontró ningún agente con rol "Content Creator & Copywriter" activo para el sitio: ${siteId}`);
            return null;
        }
        console.log(`✅ Agente con rol "Content Creator & Copywriter" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
        return {
            agentId: data[0].id,
            userId: data[0].user_id
        };
    }
    catch (error) {
        console.error('Error al buscar agente de tipo Content Creator:', error);
        return null;
    }
}
export async function findGrowthMarketerAgent(siteId: string): Promise<{
    agentId: string;
    userId: string;
} | null> {
    try {
        if (!siteId || !isValidUUID(siteId)) {
            console.error(`❌ Invalid site_id for growth marketer agent search: ${siteId}`);
            return null;
        }
        console.log(`🔍 Buscando agente con rol "Growth Marketer" para el sitio: ${siteId}`);
        const { data, error } = await supabaseAdmin
            .from('agents')
            .select('id, user_id')
            .eq('site_id', siteId)
            .eq('status', 'active')
            .eq('role', 'Growth Marketer')
            .order('created_at', { ascending: false })
            .limit(1);
        if (error) {
            console.error('Error al buscar agente con rol "Growth Marketer":', error);
            return null;
        }
        if (!data || data.length === 0) {
            console.log(`⚠️ No se encontró ningún agente con rol "Growth Marketer" activo para el sitio: ${siteId}`);
            return null;
        }
        console.log(`✅ Agente con rol "Growth Marketer" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
        return {
            agentId: data[0].id,
            userId: data[0].user_id
        };
    }
    catch (error) {
        console.error('Error al buscar agente de tipo Growth Marketer:', error);
        return null;
    }
}
export async function validateCampaignExists(campaignId: string): Promise<boolean> {
    try {
        if (!campaignId || !isValidUUID(campaignId)) {
            return false;
        }
        const { data, error } = await supabaseAdmin
            .from('campaigns')
            .select('id')
            .eq('id', campaignId)
            .single();
        if (error || !data) {
            console.log(`⚠️ Campaign ${campaignId} does not exist in database`);
            return false;
        }
        return true;
    }
    catch (error) {
        console.error('Error validating campaign existence:', error);
        return false;
    }
}
export async function saveContentItemsToDatabase(contentItems: any[], siteId: string, commandId?: string, segmentId?: string, campaignId?: string, userId?: string): Promise<any[]> {
    try {
        if (!contentItems || !Array.isArray(contentItems) || contentItems.length === 0) {
            console.log('No content items to save');
            return [];
        }
        console.log(`Saving ${contentItems.length} content items to database`);
        let validatedCampaignId: string | undefined = campaignId;
        if (campaignId && isValidUUID(campaignId)) {
            const campaignExists = await validateCampaignExists(campaignId);
            if (!campaignExists) {
                console.log(`⚠️ Campaign ${campaignId} does not exist, removing campaign_id from content items`);
                validatedCampaignId = undefined;
            }
        }
        const formattedItems = await Promise.all(contentItems.map(async (item: any, index: number) => {
            const contentType = item.type;
            let itemCampaignId = item.campaign_id || validatedCampaignId;
            if (itemCampaignId && isValidUUID(itemCampaignId)) {
                const campaignExists = await validateCampaignExists(itemCampaignId);
                if (!campaignExists) {
                    console.log(`⚠️ Item ${index + 1}: Campaign ${itemCampaignId} does not exist, removing campaign_id`);
                    itemCampaignId = undefined;
                }
            }
            console.log(`💾 Guardando contenido ${index + 1}:`, {
                title: item.title?.substring(0, 50) + '...',
                type: contentType,
                hasType: !!contentType,
                hasInstructions: !!item.instructions,
                textLength: item.text?.length || 0,
                instructionsLength: item.instructions?.length || 0,
                campaignId: itemCampaignId || 'none',
                hasCampaignId: !!itemCampaignId
            });
            if (index === 0) {
                console.log(`🔍 Debug item structure:`, JSON.stringify(item, null, 2));
            }
            return {
                title: item.title || '',
                description: item.description || '',
                text: item.text || '',
                instructions: item.instructions || '',
                type: contentType,
                status: 'draft',
                site_id: siteId,
                segment_id: segmentId || null,
                campaign_id: itemCampaignId || null,
                command_id: commandId || null,
                user_id: userId || 'system',
                estimated_reading_time: item.estimated_reading_time ? parseInt(item.estimated_reading_time, 10) : null,
                metadata: {
                    schedule: item.schedule || null,
                    topics: item.topics || [],
                    keywords: item.keywords || [],
                    ...(item.target_audience && { target_audience: item.target_audience }),
                    ...(item.business_goal && { business_goal: item.business_goal }),
                    ...(item.distribution_channels && { distribution_channels: item.distribution_channels }),
                    ...(item.publishing_date && { publishing_date: item.publishing_date })
                }
            };
        }));
        const { data, error } = await supabaseAdmin
            .from('content')
            .insert(formattedItems)
            .select();
        if (error) {
            console.error('Error saving content items to database:', error);
            const errorMessage = error.message || 'Unknown database error';
            console.error(`Failed to save content items: ${errorMessage}`);
            return [];
        }
        console.log(`Successfully saved ${data ? data.length : 0} content items to database`);
        return data || [];
    }
    catch (error: any) {
        const errorMessage = error?.message || 'Unknown error in saveContentItemsToDatabase';
        console.error('Error in saveContentItemsToDatabase:', errorMessage);
        return [];
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
export async function waitForCommandCompletion(commandId: string, maxAttempts = 100, delayMs = 1000) {
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
export async function getCampaignInfo(campaignId: string): Promise<any | null> {
    try {
        if (!isValidUUID(campaignId)) {
            console.log(`Invalid campaign ID: ${campaignId}`);
            return null;
        }
        const { data, error } = await supabaseAdmin
            .from('campaigns')
            .select('*')
            .eq('id', campaignId)
            .single();
        if (error) {
            console.error(`Error fetching campaign info: ${error.message}`);
            return null;
        }
        return data;
    }
    catch (error) {
        console.error('Error getting campaign info:', error);
        return null;
    }
}
