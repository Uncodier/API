import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { getLeadInfo, getLeadTasks, getLeadConversations, getPreviousInteractions } from '@/lib/helpers/lead-context-helper';
import { isValidUUID, commandService, getCommandDbUuid } from './command-helpers-1';
export async function getSiteChannelsConfiguration(siteId: string): Promise<{
    hasChannels: boolean;
    configuredChannels: string[];
    channelsDetails: Record<string, any>;
    warning?: string;
}> {
    try {
        console.log(`📡 Obteniendo configuración de canales para sitio: ${siteId}`);
        const { data, error } = await supabaseAdmin
            .from('settings')
            .select('channels')
            .eq('site_id', siteId)
            .single();
        if (error || !data?.channels) {
            const warning = `⚠️ Site ${siteId} has NO channels configured in settings. Lead contact recommendations will be limited.`;
            console.warn(warning);
            return {
                hasChannels: false,
                configuredChannels: [],
                channelsDetails: {},
                warning: 'No channels configured - lead contact options will be limited'
            };
        }
        const channels = data.channels;
        const configuredChannels: string[] = [];
        const channelsDetails: Record<string, any> = {};
        if (channels.email && (channels.email.email || channels.email.aliases)) {
            configuredChannels.push('email');
            channelsDetails.email = {
                type: 'email',
                email: channels.email.email || null,
                aliases: channels.email.aliases || [],
                description: 'Email marketing and outreach'
            };
        }
        if (channels.whatsapp && channels.whatsapp.phone_number) {
            configuredChannels.push('whatsapp');
            channelsDetails.whatsapp = {
                type: 'whatsapp',
                phone_number: channels.whatsapp.phone_number,
                description: 'WhatsApp Business messaging'
            };
        }
        if (channels.phone && channels.phone.number) {
            configuredChannels.push('phone');
            channelsDetails.phone = {
                type: 'phone',
                number: channels.phone.number,
                description: 'Direct phone calls'
            };
        }
        if (channels.sms && channels.sms.phone_number) {
            configuredChannels.push('sms');
            channelsDetails.sms = {
                type: 'sms',
                phone_number: channels.sms.phone_number,
                description: 'SMS text messaging'
            };
        }
        if (channels.chat && channels.chat.enabled) {
            configuredChannels.push('chat');
            channelsDetails.chat = {
                type: 'chat',
                enabled: channels.chat.enabled,
                description: 'Live chat on website'
            };
        }
        if (channels.social && (channels.social.facebook || channels.social.twitter || channels.social.linkedin)) {
            configuredChannels.push('social');
            channelsDetails.social = {
                type: 'social',
                platforms: {
                    facebook: channels.social.facebook || null,
                    twitter: channels.social.twitter || null,
                    linkedin: channels.social.linkedin || null
                },
                description: 'Social media outreach'
            };
        }
        if (configuredChannels.length === 0) {
            const warning = `⚠️ Site ${siteId} has channels object but NO FUNCTIONAL channels configured. Available channels: ${Object.keys(channels).join(', ')}. Lead contact recommendations will be limited.`;
            console.warn(warning);
            return {
                hasChannels: false,
                configuredChannels: [],
                channelsDetails: {},
                warning: 'Channels object exists but no functional channels configured - lead contact options will be limited'
            };
        }
        console.log(`✅ Site ${siteId} has ${configuredChannels.length} channels configured: ${configuredChannels.join(', ')}`);
        return {
            hasChannels: true,
            configuredChannels,
            channelsDetails,
            warning: undefined
        };
    }
    catch (error) {
        console.error('Error al verificar configuración de canales del sitio:', error);
        const warning = `⚠️ ERROR: Could not verify channels configuration for site ${siteId}. Lead contact recommendations may be affected.`;
        console.warn(warning);
        return {
            hasChannels: false,
            configuredChannels: [],
            channelsDetails: {},
            warning: 'Could not verify channels configuration - lead contact recommendations may be affected'
        };
    }
}
export async function getAvailableTeamMembers(siteId: string): Promise<any[]> {
    try {
        console.log(`👥 Buscando team members disponibles para sitio: ${siteId}`);
        const { data: siteMembers, error } = await supabaseAdmin
            .from('site_members')
            .select('user_id, role')
            .eq('site_id', siteId)
            .eq('status', 'active')
            .in('role', ['admin', 'member', 'sales_agent']);
        if (error) {
            console.error('Error al obtener team members:', error);
            return [];
        }
        if (!siteMembers || siteMembers.length === 0) {
            console.log('⚠️ No se encontraron team members disponibles');
            return [];
        }
        const teamMembersInfo = [];
        for (const member of siteMembers) {
            try {
                const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(member.user_id);
                if (!userError && userData.user) {
                    teamMembersInfo.push({
                        id: member.user_id,
                        email: userData.user.email,
                        name: userData.user.user_metadata?.name || userData.user.user_metadata?.full_name || userData.user.email,
                        role: member.role
                    });
                }
            }
            catch (userError) {
                console.warn(`Error obteniendo info del usuario ${member.user_id}:`, userError);
            }
        }
        console.log(`✅ Encontrados ${teamMembersInfo.length} team members disponibles`);
        return teamMembersInfo;
    }
    catch (error) {
        console.error('Error al obtener team members disponibles:', error);
        return [];
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
export async function processLeadData(leadId: string): Promise<any> {
    try {
        console.log(`🔍 Procesando datos del lead: ${leadId}`);
        const leadInfo = await getLeadInfo(leadId);
        if (!leadInfo) {
            console.error(`❌ No se pudo obtener información del lead: ${leadId}`);
            return null;
        }
        const leadTasks = await getLeadTasks(leadId);
        const leadConversations = await getLeadConversations(leadId);
        const previousInteractions = await getPreviousInteractions(leadId, 10);
        console.log(`📊 Lead ${leadId}: ${leadTasks.length} tareas, ${leadConversations.length} conversaciones, ${previousInteractions.length} interacciones`);
        return {
            lead: leadInfo,
            tasks: leadTasks,
            conversations: leadConversations,
            interactions: previousInteractions
        };
    }
    catch (error) {
        console.error(`Error procesando datos del lead ${leadId}:`, error);
        return null;
    }
}
export function groupLeadsByCompany(leadsData: any[]): Map<string, any[]> {
    const companiesMap = new Map<string, any[]>();
    for (const leadData of leadsData) {
        if (!leadData || !leadData.lead)
            continue;
        const company = String(leadData.lead.company || 'Unknown Company');
        const companyKey = company.toLowerCase().trim();
        if (!companiesMap.has(companyKey)) {
            companiesMap.set(companyKey, []);
        }
        companiesMap.get(companyKey)!.push(leadData);
    }
    return companiesMap;
}
