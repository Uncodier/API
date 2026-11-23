import { websiteThread } from './web-thread';
import { LEGACY_DEFAULT_AGENT_FILTER } from '@/lib/services/agents/legacy-default-filter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
// Función para validar UUIDs
export function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Función para encontrar un agente de soporte al cliente activo para un sitio
// Función genérica para encontrar agentes activos por role
async function findActiveAgentByRole(siteId: string, role: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente activo con role "${role}" para el sitio: ${siteId}`);
    
    const { data, error } = await supabaseAdmin
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', role)
      .eq('status', 'active')
      .or(LEGACY_DEFAULT_AGENT_FILTER)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error(`Error al buscar agente con role "${role}":`, error);
      throw error;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente activo con role "${role}" para el sitio: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente con role "${role}" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error(`Error al buscar agente con role "${role}":`, error);
    throw error;
  }
}

export async function findActiveCustomerSupportAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Customer Support');
}

/** Only the stored assignment can select a non-default agent on a support turn. */
export async function supportThreadAgent(siteId: string, conversationId?: string, webOnly = false): Promise<string | null> {
  if (!conversationId) return null;
  const { data, error } = await supabaseAdmin
    .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
    .from('conversations').select('site_id, agent_id, channel, custom_data').eq('id', conversationId)
    .abortSignal(AbortSignal.timeout(5000)).maybeSingle();
  if (error) throw error;
  if (data && (data.site_id !== siteId || data.channel === 'internal_review' ||
      (webOnly && !websiteThread(data.channel, data.custom_data)))) throw new Error('Conversation is unavailable');
  return data?.agent_id ?? null;
}

export async function getAgentInfo(agentId: string, siteId: string): Promise<{ user_id: string, status: string } | null> {
  const { data, error } = await supabaseAdmin
    .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
    .from('agents').select('id, user_id, status').eq('id', agentId).eq('site_id', siteId)
    .eq('role', 'Customer Support').maybeSingle();
  if (error) throw error;
  return data;
}

// Función para obtener información completa del lead desde la base de datos
export async function getLeadInfo(leadId: string, siteId: string): Promise<any | null> {
  try {
    if (!siteId || !isValidUUID(siteId) || !isValidUUID(leadId)) {
      console.error(`ID de lead no válido: ${leadId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información completa del lead: ${leadId}`);
    
    // Consultar el lead en la base de datos
    const { data, error } = await supabaseAdmin
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
      .from('leads')
      .select('*')
      .eq('id', leadId).eq('site_id', siteId)
      .single();
    
    if (error) {
      // PGRST116 significa que no se encontraron filas - esto es esperado cuando el lead no existe
      if (error.code === 'PGRST116') {
        console.log(`⚠️ No se encontró el lead con ID: ${leadId}`);
        return null;
      }
      console.error('Error al obtener información del lead:', error);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ No se encontró el lead con ID: ${leadId}`);
      return null;
    }
    
    console.log(`✅ Información completa del lead recuperada: ${JSON.stringify({
      id: data.id,
      name: data.name,
      email: data.email || 'N/A',
      phone: data.phone || 'N/A',
      status: data.status || 'N/A',
      origin: data.origin || 'N/A'
    })}`);
    
    return data;
  } catch (error) {
    console.error('Error al obtener información del lead:', error);
    return null;
  }
}

// Función para validar que un lead existe en la base de datos
export async function validateLeadExists(leadId: string, siteId?: string): Promise<boolean> {
  try {
    if (!siteId || !isValidUUID(siteId) || !isValidUUID(leadId)) {
      console.log(`⚠️ Lead ID no válido: ${leadId}`);
      return false;
    }
    
    const { data, error } = await supabaseAdmin
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
      .from('leads')
      .select('id')
      .eq('id', leadId).eq('site_id', siteId)
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        console.log(`⚠️ Lead no encontrado en la base de datos: ${leadId}`);
        return false;
      }
      console.error(`❌ Error al validar lead ${leadId}:`, error);
      return false;
    }
    
    return !!data;
  } catch (error) {
    console.error(`❌ Error al validar lead ${leadId}:`, error);
    return false;
  }
}
