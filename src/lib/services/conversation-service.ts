import { supabaseAdmin } from '@/lib/database/supabase-client';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Servicio para manejar operaciones relacionadas con conversaciones
 */
export class ConversationService {
  /**
   * Busca conversaciones existentes basada en origen y tiempo
   * @param leadId - ID del lead (opcional)
   * @param visitorId - ID del visitante (opcional)
   * @param siteId - ID del sitio (opcional)
   * @param origin - Origen de la conversación (whatsapp, email, etc.)
   * @param phone - Teléfono del contacto (opcional)
   * @param email - Email del contacto (opcional)
   * @returns ID de la conversación existente o null si no se encuentra
   */
  static async findExistingConversation(
    leadId?: string,
    visitorId?: string,
    siteId?: string,
    origin?: string,
    phone?: string,
    email?: string
  ): Promise<string | null> {
    try {
      if (!leadId && !visitorId && !siteId && !phone && !email) {
        console.log('⚠️ No se proporcionó información suficiente para buscar conversación existente');
        return null;
      }

      // Determinar el período de búsqueda basado en el origen
      let daysBefore = 30; // Por defecto 30 días
      if (origin === 'whatsapp') {
        daysBefore = 15; // 15 días para WhatsApp
      } else if (origin === 'email') {
        daysBefore = 30; // 30 días (1 mes) para email
      }

      const cutoffDate = new Date(Date.now() - daysBefore * 24 * 60 * 60 * 1000).toISOString();
      
      console.log(`🔍 Buscando conversación existente para origen="${origin}" en los últimos ${daysBefore} días`);

      // Construir la consulta base
      let query = supabaseAdmin
        .from('conversations')
        .select('id, title, created_at, updated_at, status, channel')
        .eq('status', 'active')
        .gte('updated_at', cutoffDate)
        .order('updated_at', { ascending: false });

      // Añadir filtros según la información disponible
      if (leadId && isValidUUID(leadId)) {
        query = query.eq('lead_id', leadId);
        console.log(`🔍 Filtrando por lead_id: ${leadId}`);
      } else if (visitorId && isValidUUID(visitorId)) {
        query = query.eq('visitor_id', visitorId).is('lead_id', null);
        console.log(`🔍 Filtrando por visitor_id: ${visitorId}`);
      }

      if (siteId && isValidUUID(siteId)) {
        query = query.eq('site_id', siteId);
        console.log(`🔍 Filtrando por site_id: ${siteId}`);
      }

      // Filtrar por canal si el origen está especificado
      if (origin && origin !== 'chat') {
        query = query.eq('channel', origin);
        console.log(`🔍 Filtrando por channel: ${origin}`);
      }

      const { data, error } = await query.limit(1);

      if (error) {
        console.error('Error al buscar conversación existente:', error);
        return null;
      }

      if (!data || data.length === 0) {
        console.log(`⚠️ No se encontró conversación existente para los criterios especificados`);
        return null;
      }

      const conversation = data[0];
      console.log(`✅ Conversación existente encontrada: ${conversation.id} (última actualización: ${conversation.updated_at})`);
      
      return conversation.id;
    } catch (error) {
      console.error('Error al buscar conversación existente:', error);
      return null;
    }
  }

  /**
   * Obtener el historial de una conversación
   * @param conversationId - ID de la conversación
   * @returns Array de mensajes formateados o null si hay error
   */
  static async getConversationHistory(conversationId: string): Promise<Array<{role: string, content: string}> | null> {
    try {
      if (!isValidUUID(conversationId)) {
        console.error(`ID de conversación no válido: ${conversationId}`);
        return null;
      }
      
      console.log(`🔍 Obteniendo historial de conversación: ${conversationId}`);
      
      // Consultar todos los mensajes de la conversación ordenados por fecha de creación
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
      
      // Log de roles encontrados para depuración
      const rolesFound = data.map(msg => msg.role || msg.sender_type || 'undefined').join(', ');
      console.log(`🔍 Roles encontrados en los mensajes: ${rolesFound}`);
      
      // Formatear los mensajes para el contexto del comando
      const formattedMessages = data.map(msg => {
        // Determinar el rol según los campos disponibles
        let role = 'user';
        
        if (msg.role) {
          // Si el campo role existe, usarlo directamente
          role = msg.role;
        } else if (msg.sender_type) {
          // Si existe sender_type, usarlo directamente también
          role = msg.sender_type;
        } else if (msg.visitor_id) {
          // Si hay visitor_id pero no role ni sender_type, asignar 'visitor'
          role = 'visitor';
        } else if (!msg.user_id) {
          // Si no hay user_id, asumimos que es asistente
          role = 'assistant';
        }
        
        // Log detallado para depuración
        console.log(`📝 Mensaje ${msg.id}: role=${role}, visitor_id=${msg.visitor_id || 'N/A'}, user_id=${msg.user_id || 'N/A'}`);
        
        return {
          role,
          content: msg.content
        };
      });
      
      return formattedMessages;
    } catch (error) {
      console.error('Error al obtener historial de conversación:', error);
      return null;
    }
  }

  /**
   * Formatear el historial de conversación como texto para el contexto
   * @param messages - Array de mensajes
   * @returns String formateado para contexto
   */
  static formatConversationHistoryForContext(messages: Array<{role: string, content: string}>): string {
    if (!messages || messages.length === 0) {
      return '';
    }
    
    let formattedHistory = '```conversation\n';
    
    messages.forEach((msg, index) => {
      // Mejorado para soportar múltiples tipos de roles
      let roleDisplay = 'ASSISTANT';
      
      // Mapear diferentes roles a su visualización adecuada
      if (msg.role === 'user' || msg.role === 'visitor') {
        roleDisplay = 'USER';
      } else if (msg.role === 'team_member') {
        roleDisplay = 'TEAM';
      } else if (msg.role === 'assistant' || msg.role === 'agent') {
        roleDisplay = 'ASSISTANT';
      } else if (msg.role === 'system') {
        roleDisplay = 'SYSTEM';
      }
      
      formattedHistory += `[${index + 1}] ${roleDisplay}: ${msg.content.trim()}\n`;
      
      // Add a separator between messages for better readability
      if (index < messages.length - 1) {
        formattedHistory += '---\n';
      }
    });
    
    formattedHistory += '```';
    return formattedHistory;
  }
} 