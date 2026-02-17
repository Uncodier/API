import { supabaseAdmin } from '@/lib/database/supabase-client';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';
import { BackgroundBuilder } from '@/lib/agentbase/services/agent/BackgroundServices/BackgroundBuilder';
import { DataFetcher } from '@/lib/agentbase/services/agent/BackgroundServices/DataFetcher';
import { getContextMemories } from '@/lib/services/agent-memory-tools-service';

// Tool imports
import { generateImageTool } from '@/app/api/agents/tools/generateImage/assistantProtocol';
import { generateVideoTool } from '@/app/api/agents/tools/generateVideo/assistantProtocol';
import { renameInstanceTool } from '@/app/api/agents/tools/renameInstance/assistantProtocol';
import { updateSiteSettingsTool } from '@/app/api/agents/tools/updateSiteSettings/assistantProtocol';
import { webSearchTool } from '@/app/api/agents/tools/webSearch/assistantProtocol';
import { saveOnMemoryTool } from '@/app/api/agents/tools/saveOnMemory/assistantProtocol';
import { getMemoriesTool } from '@/app/api/agents/tools/getMemories/assistantProtocol';
import { createTaskTool } from '@/app/api/agents/tools/createTask/assistantProtocol';
import { getTaskTool } from '@/app/api/agents/tools/getTask/assistantProtocol';
import { updateTaskTool } from '@/app/api/agents/tools/updateTask/assistantProtocol';
import { getRequirementsTool } from '@/app/api/agents/tools/getRequirements/assistantProtocol';
import { createRequirementTool } from '@/app/api/agents/tools/createRequirement/assistantProtocol';
import { updateRequirementTool } from '@/app/api/agents/tools/updateRequirement/assistantProtocol';
import { getLeadTool } from '@/app/api/agents/tools/getLead/assistantProtocol';
import { createLeadTool } from '@/app/api/agents/tools/createLead/assistantProtocol';
import { updateLeadTool } from '@/app/api/agents/tools/updateLead/assistantProtocol';
import { sendEmailTool } from '@/app/api/agents/tools/sendEmail/assistantProtocol';
import { salesOrderTool } from '@/app/api/agents/tools/sales-order/assistantProtocol';
import { scheduleDateTool } from '@/app/api/agents/tools/schedule-date/assistantProtocol';
import { qualifyLeadTool } from '@/app/api/agents/tools/qualify-lead/assistantProtocol';
import { identifyLeadTool } from '@/app/api/agents/tools/identify-lead/assistantProtocol';
import { getAvailableAppointmentSlotsTool } from '@/app/api/agents/tools/get-available-appointment-slots/assistantProtocol';
import { analyzeICPTotalCountTool } from '@/app/api/agents/tools/analyzeICPTotalCount/assistantProtocol';
import { createIcpMiningTool } from '@/app/api/agents/tools/createIcpMining/assistantProtocol';
import { getFinderCategoryIdsTool } from '@/app/api/agents/tools/getFinderCategoryIds/assistantProtocol';
import { getContentTool } from '@/app/api/agents/tools/getContent/assistantProtocol';
import { createContentTool } from '@/app/api/agents/tools/createContent/assistantProtocol';
import { updateContentTool } from '@/app/api/agents/tools/updateContent/assistantProtocol';
import { searchRegionVenuesTool } from '@/app/api/agents/tools/searchRegionVenues/assistantProtocol';

/**
 * Fetch relevant memories for assistant context (site_id, user_id, instance_id)
 */
export async function fetchMemoriesContext(
  site_id: string,
  user_id: string | undefined,
  instance_id?: string
): Promise<string> {
  if (!user_id) return '';
  try {
    const agent = await findGrowthRobotAgent(site_id);
    if (!agent) return '';
    return getContextMemories(agent.agentId, user_id, {
      instance_id,
      limit: 15,
    });
  } catch (err) {
    console.error('[Assistant] Error fetching memories context:', err);
    return '';
  }
}

/**
 * Generate agent background using BackgroundBuilder service
 */
export async function generateAgentBackground(siteId: string): Promise<string> {
  try {
    console.log(`🧩 [Assistant] Generating agent background for site: ${siteId}`);
    
    // Find the Growth Robot agent for this site
    const robotAgent = await findGrowthRobotAgent(siteId);
    if (!robotAgent) {
      console.log(`⚠️ [Assistant] No Growth Robot agent found for site: ${siteId}`);
      return '';
    }
    
    console.log(`✅ [Assistant] Found Growth Robot agent: ${robotAgent.agentId}`);
    
    // Fetch agent data from database
    const { data: agentData, error: agentError } = await supabaseAdmin
      .from('agents')
      .select('*')
      .eq('id', robotAgent.agentId)
      .single();
    
    if (agentError || !agentData) {
      console.error(`❌ [Assistant] Error fetching agent data:`, agentError);
      return '';
    }
    
    // Get site information and campaigns
    const siteInfo = await DataFetcher.getSiteInfo(siteId);
    const activeCampaigns = await DataFetcher.getActiveCampaigns(siteId);
    
    console.log(`🔍 [Assistant] Site info available: ${siteInfo ? 'YES' : 'NO'}`);
    console.log(`🔍 [Assistant] Active campaigns: ${activeCampaigns?.length || 0}`);
    
    // Generate background using BackgroundBuilder
    const background = BackgroundBuilder.buildAgentPrompt(
      agentData.id,
      agentData.name,
      agentData.description,
      agentData.capabilities || [],
      agentData.backstory,
      agentData.system_prompt,
      agentData.agent_prompt,
      siteInfo,
      activeCampaigns
    );
    
    console.log(`✅ [Assistant] Generated agent background (${background.length} characters)`);
    return background;
    
  } catch (error) {
    console.error(`❌ [Assistant] Error generating agent background:`, error);
    return '';
  }
}

/**
 * Instruction for ICP/Finder tools: categories use IDs, not free text.
 * Must call getFinderCategoryIds BEFORE analyzeICPTotalCount or createIcpMining.
 */
export const ICP_CATEGORY_IDS_INSTRUCTION = `
🔑 ICP/Finder category IDs: For analyzeICPTotalCount and createIcpMining, industries, locations, person_skills, organizations, organization_keywords, and web_technologies require IDs—NOT free text. You MUST call getFinderCategoryIds first with the category and search term (q) to obtain the correct IDs, then pass those IDs in the query object. Example: user says "technology industry" → call getFinderCategoryIds(category: "industries", q: "technology") → use returned id in the query.`;

/**
 * Determine the instance type and available tools based on instance data and environment
 */
export function determineInstanceCapabilities(instance: any, use_sdk_tools: boolean): {
  isScrapybaraInstance: boolean;
  shouldUseSDKTools: boolean;
  provider: 'scrapybara' | 'azure' | 'openai';
  capabilities: {
    hasPCTools: boolean;
    hasBrowserAutomation: boolean;
    hasFileEditing: boolean;
    hasCommandExecution: boolean;
  };
} {
  const providerEnv = process.env.ROBOT_SDK_PROVIDER;
  const provider = (providerEnv === 'scrapybara' || providerEnv === 'azure' || providerEnv === 'openai') 
    ? providerEnv 
    : 'scrapybara';
  
  // Determine if this is a Scrapybara instance
  const isScrapybaraInstance = provider === 'scrapybara';
  const shouldUseSDKTools = use_sdk_tools || isScrapybaraInstance;
  
  // Determine capabilities based on instance type and tools
  const capabilities = {
    hasPCTools: shouldUseSDKTools && instance?.provider_instance_id,
    hasBrowserAutomation: shouldUseSDKTools && instance?.provider_instance_id,
    hasFileEditing: shouldUseSDKTools && instance?.provider_instance_id,
    hasCommandExecution: shouldUseSDKTools && instance?.provider_instance_id,
  };
  
  return {
    isScrapybaraInstance,
    shouldUseSDKTools,
    provider,
    capabilities,
  };
}

/**
 * Helper to get all assistant tools including custom ones
 */
export const getAssistantTools = (
  siteId: string,
  userId: string | undefined,
  instanceId: string,
  customTools: any[] = []
) => {
  return [
    ...customTools,
    generateImageTool(siteId, instanceId),
    generateVideoTool(siteId, instanceId),
    renameInstanceTool(siteId, instanceId),
    updateSiteSettingsTool(siteId),
    webSearchTool(),
    saveOnMemoryTool(siteId, userId, instanceId),
    getMemoriesTool(siteId, userId, instanceId),
    createTaskTool(siteId, userId),
    getTaskTool(siteId, userId),
    updateTaskTool(siteId, userId),
    getRequirementsTool(siteId, userId),
    createRequirementTool(siteId, userId),
    updateRequirementTool(siteId, userId),
    getLeadTool(siteId, userId),
    createLeadTool(siteId, userId),
    updateLeadTool(siteId, userId),
    sendEmailTool(siteId),
    salesOrderTool(siteId),
    scheduleDateTool(siteId, instanceId),
    qualifyLeadTool(siteId),
    identifyLeadTool(siteId),
    getAvailableAppointmentSlotsTool(siteId),
    getFinderCategoryIdsTool(siteId),
    analyzeICPTotalCountTool(siteId),
    createIcpMiningTool(siteId),
    getContentTool(siteId, userId),
    createContentTool(siteId, userId),
    updateContentTool(siteId, userId),
    searchRegionVenuesTool(siteId),
  ];
};
