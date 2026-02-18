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
import { memoriesTool } from '@/app/api/agents/tools/memories/assistantProtocol';
import { tasksTool } from '@/app/api/agents/tools/tasks/assistantProtocol';
import { requirementsTool } from '@/app/api/agents/tools/requirements/assistantProtocol';
import { leadsTool } from '@/app/api/agents/tools/leads/assistantProtocol';
import { contentTool } from '@/app/api/agents/tools/content/assistantProtocol';
import { sendEmailTool } from '@/app/api/agents/tools/sendEmail/assistantProtocol';
import { configureEmailTool } from '@/app/api/agents/tools/configureEmail/assistantProtocol';
import { salesOrderTool } from '@/app/api/agents/tools/sales-order/assistantProtocol';
import { salesTool } from '@/app/api/agents/tools/sales/assistantProtocol';
import { schedulingTool } from '@/app/api/agents/tools/scheduling/assistantProtocol';
import { analyzeICPTotalCountTool } from '@/app/api/agents/tools/analyzeICPTotalCount/assistantProtocol';
import { createIcpMiningTool } from '@/app/api/agents/tools/createIcpMining/assistantProtocol';
import { getFinderCategoryIdsTool } from '@/app/api/agents/tools/getFinderCategoryIds/assistantProtocol';
import { searchRegionVenuesTool } from '@/app/api/agents/tools/searchRegionVenues/assistantProtocol';
import { webhooksTool } from '@/app/api/agents/tools/webhooks/assistantProtocol';
import { urlToMarkdownTool } from '@/app/api/agents/tools/urlToMarkdown/assistantProtocol';
import { urlToSitemapTool } from '@/app/api/agents/tools/urlToSitemap/assistantProtocol';
import { segmentsTool } from '@/app/api/agents/tools/segments/assistantProtocol';
import { campaignsTool } from '@/app/api/agents/tools/campaigns/assistantProtocol';
import { assetsTool } from '@/app/api/agents/tools/assets/assistantProtocol';
import { instancePlanTool } from '@/app/api/agents/tools/instance_plan/assistantProtocol';
import { workflowsTool } from '@/app/api/agents/tools/workflows/assistantProtocol';
import { copywritingTool } from '@/app/api/agents/tools/copywriting/assistantProtocol';
import { sendWhatsAppTool } from '@/app/api/agents/tools/sendWhatsApp/assistantProtocol';
import { whatsappTemplateTool } from '@/app/api/agents/tools/whatsappTemplate/assistantProtocol';

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
    memoriesTool(siteId, userId ?? '', instanceId),
    tasksTool(siteId, userId),
    requirementsTool(siteId, userId),
    leadsTool(siteId, userId),
    contentTool(siteId, userId),
    sendEmailTool(siteId),
    configureEmailTool(siteId),
    salesOrderTool(siteId),
    salesTool(siteId),
    schedulingTool(siteId, instanceId),
    getFinderCategoryIdsTool(siteId),
    analyzeICPTotalCountTool(siteId),
    createIcpMiningTool(siteId),
    searchRegionVenuesTool(siteId),
    webhooksTool(),
    urlToMarkdownTool(),
    urlToSitemapTool(),
    segmentsTool(siteId, userId),
    campaignsTool(siteId, userId),
    assetsTool(siteId, userId),
    instancePlanTool(siteId, instanceId, userId),
    workflowsTool(siteId, userId),
    copywritingTool(siteId, userId),
    sendWhatsAppTool(siteId),
    whatsappTemplateTool(siteId),
  ];
};
