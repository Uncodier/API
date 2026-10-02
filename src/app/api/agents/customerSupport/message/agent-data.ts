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
    
    // Solo buscamos por site_id, role y status
    const { data, error } = await supabaseAdmin
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
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
    return null;
  }
}

export async function findActiveCustomerSupportAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Customer Support');
}

// Función para obtener información completa del agente
export async function getAgentInfo(agentId: string): Promise<{ user_id: string, site_id?: string } | null> {
  try {
    if (!isValidUUID(agentId)) {
      console.error(`ID de agente no válido: ${agentId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información del agente: ${agentId}`);
    
    const { data, error } = await supabaseAdmin
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
      .from('agents')
      .select('id, user_id, site_id')
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
    
    console.log(`✅ Información del agente recuperada: user_id=${data.user_id}, site_id=${data.site_id || 'N/A'}`);
    
    return {
      user_id: data.user_id,
      site_id: data.site_id
    };
  } catch (error) {
    console.error('Error al obtener información del agente:', error);
    return null;
  }
}

// Función para obtener información completa del lead desde la base de datos
export async function getLeadInfo(leadId: string): Promise<any | null> {
  try {
    if (!isValidUUID(leadId)) {
      console.error(`ID de lead no válido: ${leadId}`);
      return null;
    }
    
    console.log(`🔍 Obteniendo información completa del lead: ${leadId}`);
    
    // Consultar el lead en la base de datos
    const { data, error } = await supabaseAdmin
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
      .from('leads')
      .select('*')
      .eq('id', leadId)
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
export async function validateLeadExists(leadId: string): Promise<boolean> {
  try {
    if (!isValidUUID(leadId)) {
      console.log(`⚠️ Lead ID no válido: ${leadId}`);
      return false;
    }
    
    const { data, error } = await supabaseAdmin
      .schema(process.env.NEXT_PUBLIC_APPS_TENANT_SCHEMA || process.env.NEXT_PUBLIC_SUPABASE_SCHEMA || 'public')
      .from('leads')
      .select('id')
      .eq('id', leadId)
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
