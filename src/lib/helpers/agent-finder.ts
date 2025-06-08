import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID } from './command-utils';

// Function to find Growth Marketer agent for a site
export async function findGrowthMarketerAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for growth marketer agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente con rol "Growth Marketer" para el sitio: ${siteId}`);
    
    // Buscar un agente activo con el rol adecuado
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
  } catch (error) {
    console.error('Error al buscar agente de tipo Growth Marketer:', error);
    return null;
  }
}

// Function to find Task Manager agent for a site
export async function findTaskManagerAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for task manager agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Buscando agente con rol "Task Manager" para el sitio: ${siteId}`);
    
    // Buscar un agente activo con el rol adecuado
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('status', 'active')
      .eq('role', 'Task Manager')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error al buscar agente con rol "Task Manager":', error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontró ningún agente con rol "Task Manager" activo para el sitio: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agente con rol "Task Manager" encontrado: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error('Error al buscar agente de tipo Task Manager:', error);
    return null;
  }
}

// Function to get pending campaigns for a site
export async function getPendingCampaigns(siteId: string): Promise<any[]> {
  try {
    console.log(`🔍 Buscando campañas pendientes para el sitio: ${siteId}`);
    
    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('site_id', siteId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error al buscar campañas pendientes:', error);
      return [];
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No se encontraron campañas pendientes para el sitio: ${siteId}`);
      return [];
    }
    
    console.log(`✅ Se encontraron ${data.length} campañas pendientes`);
    return data;
  } catch (error) {
    console.error('Error al obtener campañas pendientes:', error);
    return [];
  }
} 