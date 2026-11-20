import { supabaseAdmin } from '@/lib/database/supabase-client';
import { findGrowthRobotAgent } from '@/lib/helpers/agent-finder';
import { getContextMemories } from '@/lib/services/agent-memory-tools-service';
import { BackgroundBuilder } from '@/lib/agentbase/services/agent/BackgroundServices/BackgroundBuilder';
import { DataFetcher } from '@/lib/agentbase/services/agent/BackgroundServices/DataFetcher';
import { resolveClientTimezone } from '@/lib/timezone';

export { getAssistantToolDefinitions, getAssistantTools, getInstanceAssistantTools } from './assistant-tools';

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
  return (await generateAssistantAgentIdentity(siteId, userId)).background;
}

/** The prompt and connector identity are one server selection, never instance metadata. */
export async function generateAssistantAgentIdentity(siteId: string, userId?: string): Promise<{ background: string; agentId?: string }> {
  try {
    console.log(`🧩 [Assistant] Generating agent background for site: ${siteId}`);
    
    // Find the Growth Robot agent for this site
    const robotAgent = await findGrowthRobotAgent(siteId);
    if (!robotAgent) {
      console.log(`⚠️ [Assistant] No Growth Robot agent found for site: ${siteId}`);
      return { background: '' };
    }
    
    console.log(`✅ [Assistant] Found Growth Robot agent: ${robotAgent.agentId}`);
    
    // Fetch agent data from database
    const { data: agentData, error: agentError } = await supabaseAdmin
      .from('agents')
      .select('*')
      .eq('id', robotAgent.agentId).eq('site_id', siteId).eq('status', 'active')
      .single();
    
    if (agentError || !agentData) {
      console.error(`❌ [Assistant] Error fetching agent data:`, agentError);
      return { background: '' };
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
    return { background, agentId: agentData.id };
    
  } catch (error) {
    console.error(`❌ [Assistant] Error generating agent background:`, error);
    return { background: '' };
  }
}

/**
 * Instruction for ICP/Finder tools: categories use IDs, not free text.
 * Must call getFinderCategoryIds BEFORE analyzeICPTotalCount or createIcpMining.
 */
export const ICP_CATEGORY_IDS_INSTRUCTION = `
🔑 ICP/Finder category IDs: For analyzeICPTotalCount and createIcpMining, industries, locations, person_skills, organizations, organization_keywords, and web_technologies require IDs—NOT free text. You MUST call getFinderCategoryIds (via tools) first with the category and search term (q) to obtain the correct IDs, then pass those IDs in the query object. Example: user says "technology industry" → call tools(action: "call", name: "getFinderCategoryIds", args: {category: "industries", q: "technology"}) → use returned id in the query.`;

/**
 * Instruction for Calendar and Meeting structure in Market Fit.
 */
export const BOOKING_ROUTING_INSTRUCTION = `
📅 BOOKINGS, CALENDARS & RESERVATIONS (STRICT ROUTING):
Start with \`tools\` → \`calendars\` \`action="list"\` (optional \`query\` like "Mauricio"). That single call returns team members + personal working hours, round-robin team calendars, company business_hours, and reservable catalog services. Use it BEFORE scheduling or reservation_schedules.

There are TWO completely separate booking stacks. You MUST use the correct one:

1. PEOPLE & TEAM MEETINGS (Calendars):
- Configure hours: \`calendars\` \`action="update_member_calendar"\` (person) or \`update_team_calendar\` (round-robin). Times are 24h HH:mm (8pm = 20:00). Lunch is \`breaks: [{ start: "15:00", end: "16:00" }]\`.
- Book a specific appointment: \`scheduling\` (availability/appointments) and/or \`tasks\` with \`type: "meeting"\`.
- Rule: NEVER use \`scheduling\` to change weekly hours. NEVER use \`reservations\`, \`reservation_schedules\`, or catalog checkout slots for people/meetings.
- CRITICAL: NEVER use \`update_team_calendar\` for catalog services or individual people. \`team_calendars\` are strictly for Round-Robin groups. For new reservable services, FIRST create them with \`catalog_commerce\` (\`is_reservation=true\`), then use \`update_service_schedule\`.
- Storage: Individual calendars are in \`profiles.settings->calendar\`. Team calendars are in \`settings.calendars\`. Appointments are in \`appointments\`. For availability use a returned team \`calendar_id\` or member \`user_id\`, never an agent ID.

2. CATALOG RESERVABLE ITEMS (Capacity/Products/Services):
- Use for: Booking a service, product, or capacity slot from the catalog (where \`is_reservation=true\`).
- Configure weekly windows: \`calendars\` \`action="update_service_schedule"\` or \`reservation_schedules\`.
- Book a slot: follow the \`makinari-commerce\` skill: \`reservations.get_available_slots\` then \`checkout\` with \`reservationStart\`/\`reservationEnd\`.
- Rule: NEVER use the \`scheduling\` tool or \`tasks\` for catalog capacity reservations. NEVER use \`update_team_calendar\` for services.

Ambiguous "book a service" / "set hours" requests: If it names a person/team, use stack #1. If it names a catalog item/capacity/pass, use stack #2. Ask ONE clarifying question only if both are plausible.`;

export const EXPENSES_VS_PURCHASES_INSTRUCTION = `
💵 EXPENSES VS PURCHASES:
When the user asks to register a salary ("salario") or a general expense, you MUST use the \`transactions\` tool via tools. DO NOT use the \`purchases\` tool for general expenses or salaries.
To differentiate:
- Use the \`transactions\` tool with \`type: "fixed"\` or \`type: "variable"\`.
- Include an appropriate \`description\` and \`category\`.
- Only use \`purchases\` for legacy vendor bills / accounts payable.
- For governed compras, requisitions, licitaciones, supplier invitations, adjudicaciones or approved purchase orders, load \`makinari-procurement\` via \`skill_lookup\` and discover \`procurement_*\` tools. Never substitute legacy bills for approval-controlled procurement.`;

/**
 * Primes the assistant to tie sandbox-backed deliverables to requirements + status,
 * so scope and the "living README" survive ephemeral sandbox sessions.
 */
export function getRequirementWorkflowInstruction(hasLinkedRequirement: boolean): string {
  const linkage = hasLinkedRequirement
    ? 'This session has requirement context, not permission to become its runner. For requested changes, submit one consolidated requirements action="update" with the existing and new scope in instructions. Its trusted user-message authorization is attached by the host; the existing runner processes it when idle. Use action="list" for status questions.'
    : 'If the user wants a new build, first list requirements to avoid duplicates. Create a requirement only for a genuinely new objective. For any change to existing work, submit requirements action="update" to that requirement; do not create a second executor.';

  return `
🎯 SPEC-DRIVEN VS DIRECT EXECUTION (MANDATORY WORKFLOW):
Before you execute any command, you MUST determine if the user's request is simple or complex/strategic.

1. DIRECT EXECUTION MODE (For isolated, simple tasks):
- When the user asks for simple, one-off generative media (e.g., "crea un video así", "haz un audio", "genera una imagen"), not an explicitly code-authored HTML/SVG/Canvas/Three.js animation or explainer.
- Do NOT use the \`requirements\` tool.
- Do NOT create an \`instance_plan\`.
- Immediately use the appropriate generation tool (e.g., \`generate_video\`, \`generate_audio\`, \`generate_image\`) directly to fulfill the request.
- For code-authored animations, follow motion-design-html and the existing workspace ownership/delivery rules instead. generate_video is not an HTML renderer. The host UI OUTPUT CONTRACT remains binding; never substitute footage for a requested coded composition.

2. SPEC-DRIVEN MODE (For complex/strategic tasks):
- When the user asks for broader, multi-step, or strategic initiatives (e.g., "genera una serie de videos para mejorar la reputación de mi marca", "build a new web app", "create a marketing campaign").
- FIRST, use the \`requirements\` tool to define the strategy, scope, deliverables, and acceptance criteria.
- Existing requirement changes are queued for its sole runner. Do not create or execute a competing plan in this conversation.
- Report the queued receipt honestly; it is not completed work or proof that execution has started.

🏗️ SANDBOX DELIVERABLES & REQUIREMENTS:
Whenever the user asks for a web app, site, landing page, presentation or deck (e.g. pitch), repo work, automation implemented as code, or any artifact that is produced or edited in the Vercel sandbox (sandbox_* tools, builds, git pushes from this instance):
- ${linkage}
- Use the "requirements" tool as the durable backbone: instructions must stay a living README (what exists, architecture, file layout, what is left to do). Update it at the end of each substantive cycle.
- Do not use "requirement_status" to claim queued feedback has started execution.
- If system/plan mode expects an "instance_plan", follow the existing PLAN MODE rules in addition — the requirement describes *what* we are building; the plan breaks down *steps* when that mode is active.
- Prefer listing requirements (action "list") before creating duplicates for the same site or initiative.
- For QUICK, SIMPLE changes to a requirement-owned repository, use the same queued requirements update, not a competing \`update_repo\` execution.

📋 BACKLOG MANAGEMENT (CRITICAL FOR PLANS):
- Before creating or executing an \`instance_plan\`, you MUST use the \`requirement_backlog\` tool to check the status of items.
- Plans linked to \`done\` backlog items will be AUTOMATICALLY CANCELLED by the system.
- Model-facing tools cannot reopen \`done\` or \`needs_review\` items. For genuinely new scope, \`upsert\` a new \`core\` remediation item. A quarantined item may be reopened only by the external user-action recovery path.`;
}

export const GEAR_PROJECT_SWITCH_INSTRUCTION = `
🔄 PROJECT SWITCHING (GEAR ONLY):
If the user asks to change or switch their active project (e.g. "cambia mi proyecto", "quiero usar otro proyecto"), you MUST follow these steps strictly using \`tools\`:
1. First, call \`tools({ action: "call", name: "instance_project", args: { action: "list" } })\` to get the list of their available projects.
2. Show them the list and ask which one they want to manage.
3. Once they reply with their choice, call \`tools({ action: "call", name: "instance_project", args: { action: "set", site_id: "<selected_id>" } })\` to change the active project.
Do not perform any other actions or guess the project ID until they confirm.`;

export const EXTERNAL_API_INTEGRATION_INSTRUCTION = `
🔗 EXTERNAL API INTEGRATIONS & SECRETS:
If you need to perform an action using a third-party API that does not have a specific native tool (e.g., calling an external provider's REST API):
1. First, check if the required API key or secret exists by calling the \`list_site_secrets\` tool via \`tools\`.
2. If the secret does not exist, ask the user to provide the API key. Once provided, IMMEDIATELY save it using the \`create_site_secret\` tool via \`tools\` so it is securely stored and removed from the conversation context. Inform the user you have saved it securely.
3. To perform the actual API request, DO NOT output a mock response or write a fetch script. You MUST use the \`integration_api_request\` tool via \`tools\`, passing the saved \`secret_id\`. The backend will inject the key automatically.`;

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
