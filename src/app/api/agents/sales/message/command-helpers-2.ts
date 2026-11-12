import { NextResponse } from 'next/server';
import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';
import { getCommandById as dbGetCommandById } from '@/lib/database/command-db';
import { DatabaseAdapter } from '@/lib/agentbase/adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { getTaskDeduplicationPolicy, TASK_DEDUPLICATION_KEY_DESCRIPTION } from '@/app/api/agents/customerSupport/support-policies';
import { commandTools } from './command-tools';
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
