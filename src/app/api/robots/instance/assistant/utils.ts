import { supabaseAdmin } from '@/lib/database/supabase-client';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';
import { normalizePhoneForStorage } from '@/lib/utils/phone-normalizer';
import { getContextMemories } from '@/lib/services/agent-memory-tools-service';
import { BackgroundBuilder } from '@/lib/agentbase/services/agent/BackgroundServices/BackgroundBuilder';
import { DataFetcher } from '@/lib/agentbase/services/agent/BackgroundServices/DataFetcher';
import { resolveClientTimezone } from '@/lib/timezone';

// Tool imports
import { generateImageTool } from '@/app/api/agents/tools/generateImage/assistantProtocol';
import { generateVideoTool } from '@/app/api/agents/tools/generateVideo/assistantProtocol';
import { generateAudioTool } from '@/app/api/agents/tools/generateAudio/assistantProtocol';
import { instanceTool } from '@/app/api/agents/tools/instance/assistantProtocol';
import { updateSiteSettingsTool } from '@/app/api/agents/tools/updateSiteSettings/assistantProtocol';
import { webSearchTool } from '@/app/api/agents/tools/webSearch/assistantProtocol';
import { routeTools } from '@/app/api/agents/tools/tool_lookup/assistantProtocol';
import { skillLookupTool } from '@/app/api/agents/tools/sandbox/skill-lookup-tool';
import { memoriesTool } from '@/app/api/agents/tools/memories/assistantProtocol';
import { tasksTool } from '@/app/api/agents/tools/tasks/assistantProtocol';
import { requirementsTool } from '@/app/api/agents/tools/requirements/assistantProtocol';
import { leadsTool } from '@/app/api/agents/tools/leads/assistantProtocol';
import { catalogCommerceTool } from '@/app/api/agents/tools/catalog_commerce/assistantProtocol';
import { reservationSchedulesTool } from '@/app/api/agents/tools/reservation_schedules/assistantProtocol';
import { calendarsTool } from '@/app/api/agents/tools/calendars/assistantProtocol';
import { reservationsTool } from '@/app/api/agents/tools/reservations/assistantProtocol';
import { checkoutTool } from '@/app/api/agents/tools/checkout/assistantProtocol';
import { entitlementsTool } from '@/app/api/agents/tools/entitlements/assistantProtocol';
import { quotationItemsTool } from '@/app/api/agents/tools/quotation_items/assistantProtocol';
import { quotationsTool } from '@/app/api/agents/tools/quotations/assistantProtocol';
import { purchasesTool } from '@/app/api/agents/tools/purchases/assistantProtocol';
import { purchaseItemsTool } from '@/app/api/agents/tools/purchase_items/assistantProtocol';
import { subscriptionPlanItemsTool } from '@/app/api/agents/tools/subscription_plan_items/assistantProtocol';
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
import { activateCodingAgentsTool } from '@/app/api/agents/tools/activate_coding_agents/assistantProtocol';
import { updateRepoTool } from '@/app/api/agents/tools/update_repo/assistantProtocol';
import { showArtifactTool } from '@/app/api/agents/tools/show_artifact/assistantProtocol';

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
export async function generateAgentBackground(siteId: string, userId?: string): Promise<string> {
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
    
    const timezone = await resolveClientTimezone({ userId, siteId });
    const background = BackgroundBuilder.buildAgentPrompt(
      agentData.id,
      agentData.name,
      agentData.description,
      agentData.capabilities || [],
      agentData.backstory,
      agentData.system_prompt,
      agentData.agent_prompt,
      siteInfo,
      activeCampaigns,
      timezone
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
🔑 ICP/Finder category IDs: For analyzeICPTotalCount and createIcpMining, industries, locations, person_skills, organizations, organization_keywords, and web_technologies require IDs—NOT free text. You MUST call getFinderCategoryIds (via tool_lookup) first with the category and search term (q) to obtain the correct IDs, then pass those IDs in the query object. Example: user says "technology industry" → call tool_lookup(action: "call", name: "getFinderCategoryIds", args: {category: "industries", q: "technology"}) → use returned id in the query.`;

/**
 * Instruction for Calendar and Meeting structure in Market Fit.
 */
export const BOOKING_ROUTING_INSTRUCTION = `
📅 BOOKINGS, CALENDARS & RESERVATIONS (STRICT ROUTING):
Start with \`tool_lookup\` → \`calendars\` \`action="list"\` (optional \`query\` like "Mauricio"). That single call returns team members + personal working hours, round-robin team calendars, company business_hours, and reservable catalog services. Use it BEFORE scheduling or reservation_schedules.

There are TWO completely separate booking stacks. You MUST use the correct one:

1. PEOPLE & TEAM MEETINGS (Calendars):
- Configure hours: \`calendars\` \`action="update_member_calendar"\` (person) or \`update_team_calendar\` (round-robin). Times are 24h HH:mm (8pm = 20:00). Lunch is \`breaks: [{ start: "15:00", end: "16:00" }]\`.
- Book a specific appointment: \`scheduling\` (availability/appointments) and/or \`tasks\` with \`type: "meeting"\`.
- Rule: NEVER use \`scheduling\` to change weekly hours. NEVER use \`reservations\`, \`reservation_schedules\`, or catalog checkout slots for people/meetings.
- Storage: Individual calendars are in \`profiles.settings->calendar\`. Team calendars are in \`settings.calendars\`. Appointments are \`tasks\` with \`type: "meeting"\`.

2. CATALOG RESERVABLE ITEMS (Capacity/Products/Services):
- Use for: Booking a service, product, or capacity slot from the catalog (where \`is_reservation=true\`).
- Configure weekly windows: \`calendars\` \`action="update_service_schedule"\` or \`reservation_schedules\`.
- Book a slot: follow the \`makinari-commerce\` skill: \`reservations.get_available_slots\` then \`checkout\` with \`reservationStart\`/\`reservationEnd\`.
- Rule: NEVER use the \`scheduling\` tool or \`tasks\` for catalog capacity reservations.

Ambiguous "book a service" / "set hours" requests: If it names a person/team, use stack #1. If it names a catalog item/capacity/pass, use stack #2. Ask ONE clarifying question only if both are plausible.`;

/**
 * Primes the assistant to tie sandbox-backed deliverables to requirements + status,
 * so scope and the "living README" survive ephemeral sandbox sessions.
 */
export function getRequirementWorkflowInstruction(hasLinkedRequirement: boolean): string {
  const linkage = hasLinkedRequirement
    ? 'This instance already has requirement_status rows — treat them as authoritative context. Keep the requirement "instructions" field updated after every meaningful change, and use requirement_status to record progress or blockers. If the user asks for a SIMPLE code change directly on an existing repository (e.g. "add Events to the nav menu"), DO NOT create a backlog item and DO NOT generate a full instance_plan. Instead, use the `update_repo` tool immediately to execute the instruction.'
    : 'If the user wants a new build (no requirement in context yet), create a requirement early with action "create": title, clear instructions (scope, deliverables, tech constraints, acceptance criteria), and set status to "in-progress" when you start execution. If the user asks for a simple fix on an existing requirement, use the `update_repo` tool instead of generating a full plan.';

  return `
🎯 SPEC-DRIVEN VS DIRECT EXECUTION (MANDATORY WORKFLOW):
Before you execute any command, you MUST determine if the user's request is simple or complex/strategic.

1. DIRECT EXECUTION MODE (For isolated, simple tasks):
- When the user asks for simple, one-off media generation (e.g., "crea un video así", "haz un audio", "genera una imagen").
- Do NOT use the \`requirements\` tool.
- Do NOT create an \`instance_plan\`.
- Immediately use the appropriate generation tool (e.g., \`generate_video\`, \`generate_audio\`, \`generate_image\`) directly to fulfill the request.

2. SPEC-DRIVEN MODE (For complex/strategic tasks):
- When the user asks for broader, multi-step, or strategic initiatives (e.g., "genera una serie de videos para mejorar la reputación de mi marca", "build a new web app", "create a marketing campaign").
- FIRST, use the \`requirements\` tool to define the strategy, scope, deliverables, and acceptance criteria.
- THEN, create an \`instance_plan\` to break down the execution into actionable steps.
- FINALLY, execute the plan steps.

🏗️ SANDBOX DELIVERABLES & REQUIREMENTS:
Whenever the user asks for a web app, site, landing page, presentation or deck (e.g. pitch), repo work, automation implemented as code, or any artifact that is produced or edited in the Vercel sandbox (sandbox_* tools, builds, git pushes from this instance):
- ${linkage}
- Use the "requirements" tool as the durable backbone: instructions must stay a living README (what exists, architecture, file layout, what is left to do). Update it at the end of each substantive cycle.
- Use the "requirement_status" tool to log milestones, reviews, or when work returns to in-progress after feedback.
- If system/plan mode expects an "instance_plan", follow the existing PLAN MODE rules in addition — the requirement describes *what* we are building; the plan breaks down *steps* when that mode is active.
- Prefer listing requirements (action "list") before creating duplicates for the same site or initiative.
- For QUICK, SIMPLE code modifications on an already-existing repository, bypass complex planning and use the \`update_repo\` tool to execute the instruction directly in the background.

📋 BACKLOG MANAGEMENT (CRITICAL FOR PLANS):
- Before creating or executing an \`instance_plan\`, you MUST use the \`requirement_backlog\` tool to check the status of items.
- Plans linked to \`done\` backlog items will be AUTOMATICALLY CANCELLED by the system.
- If you need to rework or rewrite something that is already "done", you MUST either reopen the existing item (\`set_status\` to \`in_progress\` with \`confirm_reopen: true\`) or \`upsert\` a new \`core\` tier item. Only then can you create a new \`instance_plan\` for it.`;
}

/**
 * Determine the instance type and available tools based on instance data and environment
 */
export function determineInstanceCapabilities(instance: any, use_sdk_tools: boolean): {
  isScrapybaraInstance: boolean;
  shouldUseSDKTools: boolean;
  provider: 'azure' | 'openai' | 'gemini';
  capabilities: {
    hasPCTools: boolean;
    hasBrowserAutomation: boolean;
    hasFileEditing: boolean;
    hasCommandExecution: boolean;
  };
} {
  const providerEnv = process.env.ROBOT_SDK_PROVIDER;
  const provider = (providerEnv === 'azure' || providerEnv === 'openai' || providerEnv === 'gemini') 
    ? providerEnv 
    : 'gemini';
  
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
    catalogCommerceTool(siteId),
    reservationSchedulesTool(siteId),
    calendarsTool(siteId),
    reservationsTool(siteId),
    checkoutTool(siteId),
    entitlementsTool(siteId),
    quotationsTool(siteId),
    quotationItemsTool(siteId),
    purchasesTool(siteId),
    purchaseItemsTool(siteId),
    subscriptionPlanItemsTool(siteId),
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
    skillLookupTool(),
    activateCodingAgentsTool(),
    updateRepoTool(siteId, instanceId, userId),
    showArtifactTool(siteId, instanceId, userId ?? ''),
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

  return routeTools(tools as any[]);
};
