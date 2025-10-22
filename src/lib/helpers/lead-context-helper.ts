import { supabaseAdmin } from '@/lib/database/supabase-client';

// Función para validar UUIDs
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para obtener la información completa del lead desde la base de datos
export async function getLeadInfo(leadId: string): Promise<any | null> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`ID de lead no válido: ${leadId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información completa del lead: ${leadId}`);
    
    // Consultar el lead en la base de datos (simplificado para evitar problemas de JOIN)
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single();
    
    if (error) {
      console.error('Error al obtener información del lead:', error);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ No se encontró el lead con ID: ${leadId}`);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error al obtener información del lead:', error);
    return null;
  }
}

// Función para obtener los últimos 5 contenidos del sitio
export async function getLatestContent(siteId: string, limit = 5): Promise<any[]> {
  try {
    if (!isValidUUID(siteId)) {
      console.error(`ID de sitio no válido: ${siteId}`);
      return [];
    }
    
    console.log(`🔍 Obteniendo últimos ${limit} contenidos publicados del sitio: ${siteId}`);
    
    const { data, error } = await supabaseAdmin
      .from('content')
      .select('*')
      .eq('site_id', siteId)
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) {
      console.error('Error al obtener contenidos:', error);
      return [];
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontraron contenidos publicados para el sitio: ${siteId}`);
      return [];
    }
    
    return data;
  } catch (error) {
    console.error('Error al obtener contenidos:', error);
    return [];
  }
}

// Función para obtener todas las tareas del lead
export async function getLeadTasks(leadId: string): Promise<any[]> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`ID de lead no válido: ${leadId}`);
      return [];
    }
    
    console.log(`🔍 Obteniendo todas las tareas del lead: ${leadId}`);
    
    const { data, error } = await supabaseAdmin
      .from('tasks')
      .select('*')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error al obtener tareas del lead:', error);
      return [];
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontraron tareas para el lead: ${leadId}`);
      return [];
    }
    
    return data;
  } catch (error) {
    console.error('Error al obtener tareas del lead:', error);
    return [];
  }
}

// Función para obtener todas las conversaciones del lead (opcionalmente con mensajes)
export async function getLeadConversations(leadId: string, includeMessages: boolean = false): Promise<any[]> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`ID de lead no válido: ${leadId}`);
      return [];
    }
    
    console.log(`🔍 Obteniendo todas las conversaciones del lead: ${leadId}${includeMessages ? ' (with messages)' : ''}`);
    
    const { data, error } = await supabaseAdmin
      .from('conversations')
      .select('id, title, status, created_at, updated_at, last_message_at, custom_data')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error al obtener conversaciones del lead:', error);
      return [];
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontraron conversaciones para el lead: ${leadId}`);
      return [];
    }
    
    // Si se solicitan mensajes, obtener los últimos 5 mensajes de cada conversación
    if (includeMessages) {
      for (const conversation of data) {
        try {
          const messages = await getConversationMessages(conversation.id, 5);
          conversation.messages = messages;
        } catch (msgError) {
          console.error(`Error obteniendo mensajes para conversación ${conversation.id}:`, msgError);
          conversation.messages = [];
        }
      }
    }
    
    return data;
  } catch (error) {
    console.error('Error al obtener conversaciones del lead:', error);
    return [];
  }
}

// Función para obtener los últimos mensajes de una conversación
export async function getConversationMessages(conversationId: string, limit: number = 5): Promise<Array<{role: string, content: string, created_at?: string}>> {
  try {
    if (!isValidUUID(conversationId)) {
      console.error(`ID de conversación no válido: ${conversationId}`);
      return [];
    }
    
    console.log(`🔍 Obteniendo últimos ${limit} mensajes de conversación: ${conversationId}`);
    
    // Consultar los últimos mensajes de la conversación ordenados por fecha de creación descendente
    const { data, error } = await supabaseAdmin
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) {
      console.error('Error al obtener mensajes de la conversación:', error);
      return [];
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontraron mensajes para la conversación: ${conversationId}`);
      return [];
    }
    
    console.log(`✅ Se encontraron ${data.length} mensajes en la conversación`);
    
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
      
      return {
        role,
        content: msg.content,
        created_at: msg.created_at
      };
    });
    
    // Ordenar cronológicamente (más antiguos primero) para mostrar en orden correcto
    return formattedMessages.reverse();
  } catch (error) {
    console.error('Error al obtener mensajes de conversación:', error);
    return [];
  }
}

// Función para obtener las interacciones previas con un lead (usando conversations y tasks)
export async function getPreviousInteractions(leadId: string, limit = 10): Promise<any[]> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`ID de lead no válido: ${leadId}`);
      return [];
    }
    
    console.log(`🔍 Obteniendo interacciones previas con el lead: ${leadId}`);
    
    const interactions: any[] = [];
    
    // Obtener conversaciones recientes
    const { data: conversations, error: convError } = await supabaseAdmin
      .from('conversations')
      .select('id, title, status, created_at, updated_at, last_message_at, custom_data')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(Math.ceil(limit / 2)); // Dividir el límite entre conversaciones y tareas
    
    if (!convError && conversations) {
      conversations.forEach(conv => {
        interactions.push({
          id: conv.id,
          type: 'conversation',
          title: conv.title || 'Conversation',
          status: conv.status,
          created_at: conv.created_at,
          updated_at: conv.updated_at,
          channel: conv.custom_data?.channel || 'unknown',
          last_activity: conv.last_message_at
        });
      });
    }
    
    // Obtener tareas recientes
    const { data: tasks, error: tasksError } = await supabaseAdmin
      .from('tasks')
      .select('id, title, type, status, created_at, updated_at, scheduled_date, stage, description')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(Math.ceil(limit / 2)); // Dividir el límite entre conversaciones y tareas
    
    if (!tasksError && tasks) {
      tasks.forEach(task => {
        interactions.push({
          id: task.id,
          type: 'task',
          title: task.title,
          task_type: task.type,
          status: task.status,
          stage: task.stage,
          description: task.description,
          created_at: task.created_at,
          updated_at: task.updated_at,
          scheduled_date: task.scheduled_date
        });
      });
    }
    
    // Ordenar todas las interacciones por fecha de creación (más recientes primero)
    interactions.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    
    // Limitar al número solicitado
    const limitedInteractions = interactions.slice(0, limit);
    
    if (limitedInteractions.length === 0) {
      console.log(`⚠️ No se encontraron interacciones previas para el lead: ${leadId}`);
      return [];
    }
    
    console.log(`✅ Se encontraron ${limitedInteractions.length} interacciones para el lead: ${leadId}`);
    return limitedInteractions;
    
  } catch (error) {
    console.error('Error al obtener interacciones previas:', error);
    return [];
  }
}

// Función para construir contexto enriquecido
export async function buildEnrichedContext(siteId: string, leadId: string): Promise<string> {
  let contextParts = [];
  
  console.log(`🔍 Construyendo contexto enriquecido para site: ${siteId}, lead: ${leadId}`);
  
  try {
    // Get top 5 published content with 5-star rating for inspiration
    const { data: fiveStarContent, error: fiveStarError } = await supabaseAdmin
      .from('content')
      .select('*')
      .eq('site_id', siteId)
      .eq('status', 'published')
      .eq('performance_rating', 5)
      .order('created_at', { ascending: false })
      .limit(5);

    if (fiveStarError) {
      console.error('Error fetching 5-star content:', fiveStarError);
    } else if (fiveStarContent && fiveStarContent.length > 0) {
      contextParts.push(`INSPIRATION CONTENT (Your company's 5-star site pieces; use only as inspiration for user-facing messages, not as the lead's content):`);
      contextParts.push(`Clarification: These items are from YOUR company site, not from the lead's company. Do not imply the lead owns them; reference only tone, style, themes or ideas.`);
      fiveStarContent.forEach((content, index) => {
        contextParts.push(`${index + 1}. ${content.title} (${content.type})`);
        if (content.description) {
          contextParts.push(`   Description: ${content.description}`);
        }
        if (content.status) {
          contextParts.push(`   Status: ${content.status}`);
        }
        contextParts.push('');
      });
    }
    
    // Obtener todas las tareas del lead
    const leadTasks = await getLeadTasks(leadId);
    if (leadTasks && leadTasks.length > 0) {
      contextParts.push(`LEAD TASKS (${leadTasks.length} total):`);
      leadTasks.forEach((task, index) => {
        contextParts.push(`${index + 1}. ${task.title} - ${task.type} (${task.status})`);
        if (task.description) {
          contextParts.push(`   Description: ${task.description}`);
        }
        if (task.scheduled_date) {
          contextParts.push(`   Scheduled: ${task.scheduled_date}`);
        }
        if (task.stage) {
          contextParts.push(`   Stage: ${task.stage}`);
        }
        contextParts.push('');
      });
    }
    
    // Obtener todas las conversaciones del lead con mensajes
    const leadConversations = await getLeadConversations(leadId, true);
    if (leadConversations && leadConversations.length > 0) {
      contextParts.push(`LEAD CONVERSATIONS (${leadConversations.length} total):`);
      leadConversations.forEach((conversation, index) => {
        contextParts.push(`${index + 1}. ${conversation.title || 'Untitled'} (${conversation.status})`);
        if (conversation.last_message_at) {
          contextParts.push(`   Last Activity: ${conversation.last_message_at}`);
        }
        if (conversation.custom_data && Object.keys(conversation.custom_data).length > 0) {
          contextParts.push(`   Channel: ${conversation.custom_data.channel || 'Unknown'}`);
        }
        
        // Agregar los últimos mensajes si están disponibles
        if (conversation.messages && conversation.messages.length > 0) {
          contextParts.push(`   Recent Messages:`);
          conversation.messages.forEach((message: any) => {
            const timestamp = message.created_at ? new Date(message.created_at).toLocaleString() : '';
            const roleLabel = message.role === 'user' ? 'Lead' : 
                             message.role === 'assistant' ? 'Assistant' : 
                             message.role === 'visitor' ? 'Visitor' : 
                             message.role === 'team_member' ? 'Team Member' : 
                             message.role;
            contextParts.push(`   - [${timestamp}] ${roleLabel}: ${message.content}`);
          });
        } else {
          contextParts.push(`   No recent messages available`);
        }
        contextParts.push('');
      });
    }
    
  } catch (error) {
    console.error('Error building enriched context:', error);
    contextParts.push('Note: Some context information could not be retrieved due to system limitations.');
  }
  
  return contextParts.join('\n');
} 

/**
 * Función helper para convertir campos que pueden ser objetos JSON a strings legibles
 * Maneja casos donde el campo puede ser string, objeto o null/undefined
 */
export function safeStringify(value: any): string {
  if (!value) {
    return 'Not provided';
  }
  
  if (typeof value === 'string') {
    return value;
  }
  
  if (typeof value === 'object') {
    // Si es un objeto, intentar extraer campos comunes como name, title, etc.
    if (value.name) {
      return value.name;
    }
    if (value.title) {
      return value.title;
    }
    if (value.company_name) {
      return value.company_name;
    }
    if (value.label) {
      return value.label;
    }
    
    // Si tiene múltiples campos, crear un string descriptivo
    if (typeof value === 'object' && value !== null) {
      const keys = Object.keys(value);
      if (keys.length > 0) {
        // Intentar crear un string legible con los valores más importantes
        const importantValues = [];
        if (value.name) importantValues.push(value.name);
        if (value.company_name) importantValues.push(value.company_name);
        if (value.title) importantValues.push(value.title);
        
        if (importantValues.length > 0) {
          return importantValues.join(' - ');
        }
        
        // Fallback: mostrar el primer valor que no sea null/undefined
        for (const key of keys) {
          if (value[key] && typeof value[key] === 'string') {
            return value[key];
          }
        }
      }
    }
    
    // Último recurso: JSON.stringify para objetos complejos
    try {
      return JSON.stringify(value);
    } catch (e) {
      return 'Unknown Object';
    }
  }
  
  // Para otros tipos (numbers, booleans, etc.)
  return String(value);
} 