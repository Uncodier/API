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
    
    // Consultar el lead en la base de datos con información adicional
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select(`
        *,
        sites:site_id(name, url),
        visitors:visitor_id(*)
      `)
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
    
    console.log(`🔍 Obteniendo últimos ${limit} contenidos del sitio: ${siteId}`);
    
    const { data, error } = await supabaseAdmin
      .from('content')
      .select('*')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) {
      console.error('Error al obtener contenidos:', error);
      return [];
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontraron contenidos para el sitio: ${siteId}`);
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

// Función para obtener todas las conversaciones del lead (sin mensajes)
export async function getLeadConversations(leadId: string): Promise<any[]> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`ID de lead no válido: ${leadId}`);
      return [];
    }
    
    console.log(`🔍 Obteniendo todas las conversaciones del lead: ${leadId}`);
    
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
    
    return data;
  } catch (error) {
    console.error('Error al obtener conversaciones del lead:', error);
    return [];
  }
}

// Función para obtener las interacciones previas con un lead
export async function getPreviousInteractions(leadId: string, limit = 10): Promise<any[]> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`ID de lead no válido: ${leadId}`);
      return [];
    }
    
    console.log(`🔍 Obteniendo interacciones previas con el lead: ${leadId}`);
    
    // Consultar las interacciones previas
    const { data, error } = await supabaseAdmin
      .from('lead_interactions')
      .select('*')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) {
      console.error('Error al obtener interacciones previas:', error);
      return [];
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontraron interacciones previas para el lead: ${leadId}`);
      return [];
    }
    
    return data;
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
    // Obtener últimos 5 contenidos
    const latestContent = await getLatestContent(siteId);
    if (latestContent && latestContent.length > 0) {
      contextParts.push(`RECENT CONTENT (Last ${latestContent.length} items):`);
      latestContent.forEach((content, index) => {
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
    
    // Obtener todas las conversaciones del lead
    const leadConversations = await getLeadConversations(leadId);
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
        contextParts.push('');
      });
    }
    
  } catch (error) {
    console.error('Error building enriched context:', error);
    contextParts.push('Note: Some context information could not be retrieved due to system limitations.');
  }
  
  return contextParts.join('\n');
} 