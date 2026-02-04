import { supabaseAdmin } from '@/lib/database/supabase-client';
import { isValidUUID } from './LeadFollowUpUtils';

// Generic function to find an active agent by role
export async function findActiveAgentByRole(siteId: string, role: string): Promise<{agentId: string, userId: string} | null> {
  try {
    if (!siteId || !isValidUUID(siteId)) {
      console.error(`❌ Invalid site_id for agent search: ${siteId}`);
      return null;
    }
    
    console.log(`🔍 Searching for active agent with role "${role}" for site: ${siteId}`);
    
    // Only search by site_id, role and status
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id')
      .eq('site_id', siteId)
      .eq('role', role)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error(`Error searching for agent with role "${role}":`, error);
      return null;
    }
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No active agent found with role "${role}" for site: ${siteId}`);
      return null;
    }
    
    console.log(`✅ Agent with role "${role}" found: ${data[0].id} (user_id: ${data[0].user_id})`);
    return {
      agentId: data[0].id,
      userId: data[0].user_id
    };
  } catch (error) {
    console.error(`Error searching for agent with role "${role}":`, error);
    return null;
  }
}

// Function to find an active sales agent for a site
export async function findActiveSalesAgent(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Sales/CRM Specialist');
}

// Function to find an active copywriter for a site
export async function findActiveCopywriter(siteId: string): Promise<{agentId: string, userId: string} | null> {
  return await findActiveAgentByRole(siteId, 'Content Creator & Copywriter');
}

export async function getAgentInfo(agentId: string): Promise<{ user_id: string; site_id?: string; tools?: any[]; activities?: any[] } | null> {
  try {
    if (!isValidUUID(agentId)) {
      console.error(`Invalid agent ID: ${agentId}`);
      return null;
    }
    
    console.log(`🔍 Getting agent information: ${agentId}`);
    
    // Query agent in database - Specify only the columns we need
    const { data, error } = await supabaseAdmin
      .from('agents')
      .select('id, user_id, site_id, configuration')
      .eq('id', agentId)
      .single();
    
    if (error) {
      console.error('Error getting agent information:', error);
      return null;
    }
    
    if (!data) {
      console.log(`⚠️ Agent not found with ID: ${agentId}`);
      return null;
    }
    
    // Parse configuration if it's a string
    let config = data.configuration;
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      } catch (e) {
        console.error('Error parsing agent configuration:', e);
        config = {};
      }
    }
    
    // Ensure config is an object
    config = config || {};
    
    return {
      user_id: data.user_id,
      site_id: data.site_id,
      tools: config.tools || [],
      activities: config.activities || []
    };
  } catch (error) {
    console.error('Error getting agent information:', error);
    return null;
  }
}
