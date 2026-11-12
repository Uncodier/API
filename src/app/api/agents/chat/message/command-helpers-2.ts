import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { getCommerceReservationsPolicy } from '@/app/api/agents/customerSupport/support-policies';
import { buildChatMessageTools } from './tools';
import { isValidUUID } from './command-helpers-1';
export async function getConversationHistory(conversationId: string): Promise<Array<{
    role: string;
    content: string;
}> | null> {
    try {
        if (!isValidUUID(conversationId)) {
            console.error(`ID de conversación no válido: ${conversationId}`);
            return null;
        }
        console.log(`🔍 Obteniendo historial de conversación: ${conversationId}`);
        const { data, error } = await supabaseAdmin
            .from('messages')
            .select('*')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: true });
        if (error) {
            console.error('Error al obtener mensajes de la conversación:', error);
            return null;
        }
        if (!data || data.length === 0) {
            console.log(`⚠️ No se encontraron mensajes para la conversación: ${conversationId}`);
            return [];
        }
        console.log(`✅ Se encontraron ${data.length} mensajes en la conversación`);
        const rolesFound = data.map(msg => msg.role || msg.sender_type || 'undefined').join(', ');
        console.log(`🔍 Roles encontrados en los mensajes: ${rolesFound}`);
        const formattedMessages = data.map(msg => {
            let role = 'user';
            if (msg.role) {
                role = msg.role;
            }
            else if (msg.sender_type) {
                role = msg.sender_type;
            }
            else if (msg.visitor_id) {
                role = 'visitor';
            }
            else if (!msg.user_id) {
                role = 'assistant';
            }
            console.log(`📝 Mensaje ${msg.id}: role=${role}, visitor_id=${msg.visitor_id || 'N/A'}, user_id=${msg.user_id || 'N/A'}`);
            return {
                role,
                content: msg.content
            };
        });
        return formattedMessages;
    }
    catch (error) {
        console.error('Error al obtener historial de conversación:', error);
        return null;
    }
}
export function formatConversationHistoryForContext(messages: Array<{
    role: string;
    content: string;
}>): string {
    if (!messages || messages.length === 0) {
        return '';
    }
    let formattedHistory = '```conversation\n';
    messages.forEach((msg, index) => {
        let roleDisplay = 'ASSISTANT';
        if (msg.role === 'user' || msg.role === 'visitor') {
            roleDisplay = 'USER';
        }
        else if (msg.role === 'team_member') {
            roleDisplay = 'TEAM';
        }
        else if (msg.role === 'assistant' || msg.role === 'agent') {
            roleDisplay = 'ASSISTANT';
        }
        else if (msg.role === 'system') {
            roleDisplay = 'SYSTEM';
        }
        formattedHistory += `[${index + 1}] ${roleDisplay}: ${msg.content.trim()}\n`;
        if (index < messages.length - 1) {
            formattedHistory += '---\n';
        }
    });
    formattedHistory += '```';
    return formattedHistory;
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
        const tools = Array.isArray(config.tools) ? config.tools : [];
        const activities = Array.isArray(config.activities) ? config.activities : [];
        console.log(`✅ Información del agente recuperada: user_id=${data.user_id}, site_id=${data.site_id || 'N/A'}`);
        console.log(`📦 Tools: ${tools.length}, Activities: ${activities.length}`);
        return {
            user_id: data.user_id,
            site_id: data.site_id,
            tools,
            activities
        };
    }
    catch (error) {
        console.error('Error al obtener información del agente:', error);
        return null;
    }
}
export async function getTeamMemberInfo(teamMemberId: string): Promise<any | null> {
    try {
        if (!isValidUUID(teamMemberId)) {
            console.error(`ID de miembro del equipo no válido: ${teamMemberId}`);
            return null;
        }
        console.log(`🔍 Obteniendo información del miembro del equipo: ${teamMemberId}`);
        const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(teamMemberId);
        if (userError || !userData || !userData.user || !userData.user.email) {
            console.error(`Error al obtener el email del usuario: ${userError?.message || 'Usuario no encontrado'}`);
            return null;
        }
        const userEmail = userData.user.email;
        console.log(`📧 Email del usuario encontrado: ${userEmail}`);
        const { data: profileData, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('email', userEmail)
            .single();
        if (profileError) {
            console.error(`Error al obtener el perfil del usuario: ${profileError.message}`);
            return null;
        }
        if (!profileData) {
            console.log(`⚠️ No se encontró el perfil para el usuario con email: ${userEmail}`);
            return null;
        }
        console.log(`✅ Perfil recuperado para: ${profileData.name || profileData.email || userEmail}`);
        return profileData;
    }
    catch (error) {
        console.error('Error al obtener información del usuario:', error);
        return null;
    }
}
