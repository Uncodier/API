import { supabaseAdmin } from '@/lib/database/supabase-client';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';
import { normalizePhoneForStorage } from '@/lib/utils/phone-normalizer';
import { getContextMemories } from '@/lib/services/agent-memory-tools-service';
import { BackgroundBuilder } from '@/lib/agentbase/services/agent/BackgroundServices/BackgroundBuilder';
import { DataFetcher } from '@/lib/agentbase/services/agent/BackgroundServices/DataFetcher';

// Tool imports
import { generateImageTool } from '@/app/api/agents/tools/generateImage/assistantProtocol';
import { generateVideoTool } from '@/app/api/agents/tools/generateVideo/assistantProtocol';
import { generateAudioTool } from '@/app/api/agents/tools/generateAudio/assistantProtocol';
import { instanceTool } from '@/app/api/agents/tools/instance/assistantProtocol';
import { updateSiteSettingsTool } from '@/app/api/agents/tools/updateSiteSettings/assistantProtocol';
import { webSearchTool } from '@/app/api/agents/tools/webSearch/assistantProtocol';
import { memoriesTool } from '@/app/api/agents/tools/memories/assistantProtocol';
import { tasksTool } from '@/app/api/agents/tools/tasks/assistantProtocol';
import { requirementsTool } from '@/app/api/agents/tools/requirements/assistantProtocol';
import { leadsTool } from '@/app/api/agents/tools/leads/assistantProtocol';
import { contentTool } from '@/app/api/agents/tools/content/assistantProtocol';
import { sendEmailTool } from '@/app/api/agents/tools/sendEmail/assistantProtocol';
import { configureEmailTool } from '@/app/api/agents/tools/configureEmail/assistantProtocol';
import { configureWhatsAppTool } from '@/app/api/agents/tools/configureWhatsApp/assistantProtocol';
import { salesOrderTool } from '@/app/api/agents/tools/sales-order/assistantProtocol';
import { salesTool } from '@/app/api/agents/tools/sales/assistantProtocol';
import { dealsTool } from '@/app/api/agents/tools/deals/assistantProtocol';
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
import { conversationsTool } from '@/app/api/agents/tools/conversations/assistantProtocol';
import { messagesTool } from '@/app/api/agents/tools/messages/assistantProtocol';
import { reportTool } from '@/app/api/agents/tools/report/assistantProtocol';
import { createAccountTool, verifyAccountTool } from '@/app/api/agents/gear/whatsapp/tools';
import { instanceProjectTool } from '@/app/api/agents/tools/instance_project/assistantProtocol';
import { createProjectTool } from '@/app/api/agents/tools/createProject/assistantProtocol';
import { systemNotificationTool } from '@/app/api/agents/tools/system_notification/assistantProtocol';
import { requirementStatusTool } from '@/app/api/agents/tools/requirement_status/assistantProtocol';
import { requirementBacklogTool } from '@/app/api/agents/tools/requirement_backlog/assistantProtocol';
import { instanceLogsTool } from '@/app/api/agents/tools/instance_logs/assistantProtocol';
import { audioToTextTool } from '@/app/api/agents/tools/audioToText/assistantProtocol';
import { createSecretTool } from '@/app/api/agents/tools/createSecret/assistantProtocol';
import { socialMediaAccountsTool } from '@/app/api/agents/tools/socialMediaAccounts/assistantProtocol';
import { socialMediaPublishTool } from '@/app/api/agents/tools/socialMediaPublish/assistantProtocol';
import { socialMediaPostsTool } from '@/app/api/agents/tools/socialMediaPosts/assistantProtocol';
import { audienceTool } from '@/app/api/agents/tools/audience/assistantProtocol';
import { sendBulkMessagesTool } from '@/app/api/agents/tools/sendBulkMessages/assistantProtocol';
import { publishTool } from '@/app/api/agents/tools/publish/assistantProtocol';

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
 * Primes the assistant to tie sandbox-backed deliverables to requirements + status,
 * so scope and the "living README" survive ephemeral sandbox sessions.
 */
export function getSandboxRequirementWorkflowInstruction(hasLinkedRequirement: boolean): string {
  const linkage = hasLinkedRequirement
    ? 'This instance already has requirement_status rows — treat them as authoritative context. Keep the requirement "instructions" field updated after every meaningful change, and use requirement_status to record progress or blockers.'
    : 'If the user wants a new build (no requirement in context yet), create a requirement early with action "create": title, clear instructions (scope, deliverables, tech constraints, acceptance criteria), and set status to "in-progress" when you start execution.';

  return `
🏗️ SANDBOX DELIVERABLES & REQUIREMENTS (MANDATORY WORKFLOW):
Whenever the user asks for a web app, site, landing page, presentation or deck (e.g. pitch), repo work, automation implemented as code, or any artifact that is produced or edited in the Vercel sandbox (sandbox_* tools, builds, git pushes from this instance):
- ${linkage}
- Use the "requirements" tool as the durable backbone: instructions must stay a living README (what exists, architecture, file layout, what is left to do). Update it at the end of each substantive cycle.
- Use the "requirement_status" tool to log milestones, reviews, or when work returns to in-progress after feedback.
- If system/plan mode expects an "instance_plan", follow the existing PLAN MODE rules in addition — the requirement describes *what* we are building; the plan breaks down *steps* when that mode is active.
- Prefer listing requirements (action "list") before creating duplicates for the same site or initiative.`;
}

/**
 * Determine the instance type and available tools based on instance data and environment
 */
export function determineInstanceCapabilities(instance: any, use_sdk_tools: boolean): {
  isScrapybaraInstance: boolean;
  shouldUseSDKTools: boolean;
  provider: 'azure' | 'openai';
  capabilities: {
    hasPCTools: boolean;
    hasBrowserAutomation: boolean;
    hasFileEditing: boolean;
    hasCommandExecution: boolean;
  };
} {
  const providerEnv = process.env.ROBOT_SDK_PROVIDER;
  const provider = (providerEnv === 'azure' || providerEnv === 'openai') 
    ? providerEnv 
    : 'azure';
  
  // Scrapybara is disabled
  const isScrapybaraInstance = false;
  const shouldUseSDKTools = false;
  
  // Determine capabilities based on instance type and tools
  const capabilities = {
    hasPCTools: false,
    hasBrowserAutomation: false,
    hasFileEditing: false,
    hasCommandExecution: false,
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
  customTools: any[] = [],
  agentType?: string,
  userPhone?: string
) => {
  const tools = [
    ...customTools,
    generateImageTool(siteId, instanceId),
    generateVideoTool(siteId, instanceId),
    generateAudioTool(siteId, instanceId),
    instanceTool(siteId, instanceId, userId),
    updateSiteSettingsTool(siteId),
    webSearchTool(siteId),
    memoriesTool(siteId, userId ?? '', instanceId),
    tasksTool(siteId, userId),
    requirementsTool(siteId, userId),
    leadsTool(siteId, userId),
    contentTool(siteId, userId),
    sendEmailTool(siteId),
    configureEmailTool(siteId),
    configureWhatsAppTool(siteId),
    salesOrderTool(siteId),
    salesTool(siteId),
    dealsTool(siteId),
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
    conversationsTool(siteId, userId),
    messagesTool(siteId),
    reportTool(siteId, userId ?? ''),
    systemNotificationTool(siteId),
    requirementStatusTool(siteId, instanceId),
    requirementBacklogTool(siteId),
    instanceLogsTool(siteId, userId ?? '', instanceId),
    createProjectTool(userId ?? ''),
    audioToTextTool(siteId),
    createSecretTool(siteId),
    socialMediaAccountsTool(siteId),
    socialMediaPublishTool(siteId),
    socialMediaPostsTool(siteId),
    audienceTool(siteId, userId ?? '', instanceId),
    sendBulkMessagesTool(siteId),
    publishTool(siteId, userId ?? '', instanceId),
  ];

  if (agentType === 'gear') {
    let normalizedPhone: string | undefined = undefined;
    if (userPhone) {
      if (userPhone.includes('@')) {
        normalizedPhone = userPhone;
      } else {
        normalizedPhone = normalizePhoneForStorage(userPhone) || userPhone;
      }
    }
    tools.push(
      instanceProjectTool(userId ?? '', normalizedPhone),
      createAccountTool(),
      verifyAccountTool()
    );
  }

  return tools;
};
