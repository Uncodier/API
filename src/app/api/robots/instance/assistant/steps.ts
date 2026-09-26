'use step';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { InstanceContextManager } from '@/lib/services/robot-instance/InstanceContextManager';
import { findAssistantManagedPlan } from '@/lib/services/workflow-robot/plan-ownership';
import { InstanceAssetsService } from '@/lib/services/robot-instance/InstanceAssetsService';
import {
  fetchMemoriesContext,
  generateAgentBackground,
  getInstanceAssistantTools,
  determineInstanceCapabilities,
  ICP_CATEGORY_IDS_INSTRUCTION,
  getRequirementWorkflowInstruction,
  BOOKING_ROUTING_INSTRUCTION,
  EXPENSES_VS_PURCHASES_INSTRUCTION,
  GEAR_PROJECT_SWITCH_INSTRUCTION,
  EXTERNAL_API_INTEGRATION_INSTRUCTION,
} from './utils';
import type { AssistantContext } from './types';
import { loadAssistantRequirementContext } from './requirement-context';
import { resolveUiMediaContract } from './ui-media-contract';
import { requiredSkillsPrompt, type AssistantSkillSelection } from './skill-selection';

export async function prepareAssistantContext(
  instanceId: string,
  message: string,
  siteId: string,
  userId: string,
  customTools: any[],
  useSdkTools: boolean,
  systemPrompt?: string,
  agentType?: string,
  userPhone?: string,
  instanceNodeId?: string,
    expectedResultsAmount?: number,
    contextString?: string,
    toolOverrides?: Record<string, any>,
    selectedSkills?: AssistantSkillSelection,
    approvedImport?: { url: string; sha256: string; userId: string },
  ): Promise<AssistantContext> {
  'use step';
  // We need to fetch the instance data inside the workflow to ensure we have the latest state
  let instanceResult = await supabaseAdmin
    .from('remote_instances')
    .select('*')
    .eq('id', instanceId)
    .single();
  // Fallback to robot_instances
  if (instanceResult.error || !instanceResult.data) {
    console.log(`[Workflow] Instance not found in remote_instances, checking robot_instances: ${instanceId}`);
    instanceResult = await supabaseAdmin
      .from('robot_instances')
      .select('*')
      .eq('id', instanceId)
      .single();
  }

  const { data: instance, error: instanceError } = instanceResult;

  if (instanceError || !instance) {
    throw new Error(`Instance not found: ${instanceId}`);
  }

  // Log execution start
  console.log(`[Workflow] Starting assistant execution for instance: ${instanceId}`);

  // Determine execution parameters
  const { isScrapybaraInstance, shouldUseSDKTools, provider, capabilities } = determineInstanceCapabilities(instance, useSdkTools);
  
  const useAssistantOnly =
    instance.status === 'uninstantiated' ||
    instance.status === 'paused' ||
    instance.status === 'stopped' ||
    instance.status === 'error' ||
    (instance.status === 'running' && !instance.provider_instance_id);

  let baseSystemPrompt = '';
  let toolsContext = '';
  let finalProvider = provider;

  if (useAssistantOnly) {
     finalProvider = 'azure'; // Force Azure for assistant-only
     baseSystemPrompt =
        instance.status === 'paused' || instance.status === 'stopped'
          ? 'You are a helpful AI assistant. This instance is currently paused, so browser automation tools are not available.'
          : instance.status === 'error'
            ? 'You are a helpful AI assistant. Browser automation encountered an error and is not available, but you can still help with questions and advice.'
            : instance.status === 'running' && !instance.provider_instance_id
              ? 'You are a helpful AI assistant. Browser automation is still provisioning and not yet available.'
              : 'You are a helpful AI assistant. This is an uninstantiated instance without browser automation tools.';
  } else {
      if (capabilities.hasPCTools && isScrapybaraInstance) {
        baseSystemPrompt = 'You are a helpful AI assistant with access to Scrapybara browser automation tools. You can control the computer, execute commands, and edit files.';
        toolsContext = '\n\n🛠️ AVAILABLE SCRAPYBARA TOOLS:\n- computer(): Control browser, click, type, navigate, take screenshots\n- bash(): Execute shell commands and system operations\n- edit(): Edit files and manage file system\n\n💡 You have full PC management capabilities through these tools.\n\n🚨 IMPORTANT: This is a Scrapybara instance - you have access to browser automation and PC control tools.';
      } else if (capabilities.hasPCTools && !isScrapybaraInstance) {
        baseSystemPrompt = 'You are a helpful AI assistant with access to PC management tools. You can control the computer, execute commands, and edit files.';
        toolsContext = '\n\n🛠️ AVAILABLE PC MANAGEMENT TOOLS:\n- computer(): Control browser, click, type, navigate, take screenshots\n- bash(): Execute shell commands and system operations\n- edit(): Edit files and manage file system\n\n💡 You have full PC management capabilities through these tools.\n\n🚨 IMPORTANT: This is our assistant instance - you have access to PC management tools for computer control.';
      } else {
        baseSystemPrompt = 'You are a helpful AI assistant. Browser automation tools are not available in this mode.';
        toolsContext = '\n\n⚠️ NOTE: PC management tools are not available in this mode. You can only provide text-based assistance.';
      }
  }

  const {
    activeRequirementId,
    requirementStatusContext,
    progressContext,
    backlogContext,
  } = await loadAssistantRequirementContext(instanceId);

  // Fetch active instance plan context
  const { data: lastPlans } = await supabaseAdmin
    .from('instance_plans')
    .select('*')
    .eq('instance_id', instanceId)
    .in('status', ['pending', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(20);

  let instance_plan_id = null;
  let activeStepContext = '';
  let allStepsContext = '';
  let lastCompletedPlanContext = '';
  const activePlan = findAssistantManagedPlan(lastPlans);
  if (activePlan) {
    
    // Determine if we should consider this plan "active" based on its steps
    let isPlanFullyDone = false;
    if (activePlan.steps && Array.isArray(activePlan.steps)) {
      isPlanFullyDone = activePlan.steps.length > 0 && activePlan.steps.every((s: any) => s.status === 'completed');
    }

    if (isPlanFullyDone) {
      // Si el plan ya está todo completado, lo tratamos como "NO ACTIVE PLAN"
      // y opcionalmente actualizamos su estado a completed de una vez para que no vuelva a salir.
      console.log(`[AssistantContext] Plan ${activePlan.id} was returned as 'in_progress' or 'pending' but all steps are 'completed'. Treating as completed.`);
      activeStepContext = `\n\n⚠️ IMPORTANT: There is NO ACTIVE PLAN (or the previous plan is already completed). If you need to execute a multi-step task, you MUST call instance_plan with action="create" to make a NEW plan. DO NOT call action="update" on a completed plan.`;
    } else {
      instance_plan_id = activePlan.id;
      
      // Determine active step
      if (activePlan.steps && Array.isArray(activePlan.steps)) {
        const stepsSummary = activePlan.steps.map((s: any) => ({
          id: s.id,
          title: s.title,
          status: s.status,
          order: s.order
        }));
        allStepsContext = `\n- Active Plan Steps: ${JSON.stringify(stepsSummary)}`;

        const inProgressStep = activePlan.steps.find((s: any) => s.status === 'in_progress');
        const pendingStep = activePlan.steps.find((s: any) => s.status === 'pending');
        const step = inProgressStep || pendingStep;
        if (step) {
          // Provide the entire active step object to the agent
          activeStepContext = `\n- Active Step Object: ${JSON.stringify(step)}\n\n⚠️ IMPORTANT: If you need to call instance_plan with action="execute_step", you MUST use the 'id' field from the 'Active Step Object' above or from the 'Plan Steps' list. DO NOT call action="list" to find the step ID.`;
        } else {
          activeStepContext = `\n\n⚠️ IMPORTANT: All steps in the active plan are completed, but the plan status is still open.`;
        }
      }
    }
  } else {
    activeStepContext = `\n\n⚠️ IMPORTANT: There is NO ACTIVE PLAN (or the previous plan is already completed). If you need to execute a multi-step task, you MUST call instance_plan with action="create" to make a NEW plan. DO NOT call action="update" on a completed plan.`;
  }

  // Fetch last completed plan title
  const { data: lastCompletedPlans } = await supabaseAdmin
    .from('instance_plans')
    .select('id, title, status')
    .eq('instance_id', instanceId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1);

  if (lastCompletedPlans && lastCompletedPlans.length > 0) {
    lastCompletedPlanContext = `\n- Last Completed Plan: "${lastCompletedPlans[0].title}" (ID: ${lastCompletedPlans[0].id})`;
  }

  const hasLinkedRequirement = Boolean(activeRequirementId);
  const uiMediaContract = await resolveUiMediaContract({
    instanceNodeId,
    instanceId,
    siteId,
    contextString,
    toolOverrides,
  });

  // Generate prompts
  const agentBackground = await generateAgentBackground(siteId, userId);
  const memoriesContext = await fetchMemoriesContext(siteId, userId, instanceId);
  const historyContext = instanceNodeId || (systemPrompt || '').includes('WORKFLOW MODE')
    ? ''
    : await new InstanceContextManager(instanceId, siteId)
        .buildHistory(message, finalProvider, finalProvider === 'azure'
          ? process.env.MICROSOFT_AZURE_OPENAI_DEPLOYMENT || 'gpt-4o'
          : process.env.AI_MODEL || (finalProvider === 'gemini' ? 'gemini-3.1-pro-preview'
            : finalProvider === 'xai'
              ? (process.env.GOOGLE_CLOUD_PROJECT_ID && !process.env.XAI_API_KEY ? 'xai/grok-4.6' : 'grok-4.6')
              : 'gpt-4o'));
  
  // Get tools list just for counting/prompt purposes here
  // We do NOT pass these instantiated tools in the return value to avoid serialization issues
  const toolsWithImageGeneration = await getInstanceAssistantTools(
    siteId,
    userId,
    instanceId,
    customTools,
    agentType,
    userPhone,
    activeRequirementId ?? undefined,
    uiMediaContract?.outputType,
  );
  
  const assetsData = await InstanceAssetsService.getAssetsContext(instanceId);
  const assetsContext = assetsData.text;
  const imageAssets = assetsData.images;

  // Instance renaming logic prompt
  const instanceName = instance.name || '';
  const genericNames = ['Assistant Session', 'New Instance', 'Untitled', 'Instance', 'Session', 'Assistant'];
  const isGenericName = genericNames.some(generic => 
    instanceName.toLowerCase().includes(generic.toLowerCase())
  );
  
  const renameInstruction = isGenericName 
    ? `\n\n⚠️ IMPORTANT: The current instance name "${instanceName}" is generic and not descriptive. You MUST automatically call the instance tool (with action="update") to give this instance a descriptive name that reflects the user's objective and conversation context. Additionally, if the current name does not accurately summarize or reflect the conversation content, you should also call the instance tool. Do this automatically without asking the user.`
    : `\n\n💡 NOTE: If the current instance name "${instanceName}" does not accurately summarize or reflect the conversation/chat content, you should automatically call the instance tool (with action="update") to update it with a more descriptive name.`;

  const requirementIdWarning = activeRequirementId ? `\n⚠️ IMPORTANT: Your Current Requirement ID is ${activeRequirementId}. Do not confuse it with your Instance ID (${instanceId}) when calling the requirements tool.` : '';
  const instanceContext = `\n\n🆔 INSTANCE CONTEXT:\n- Instance ID: ${instanceId}\n- Site ID: ${siteId}\n- User ID: ${userId}${instance_plan_id ? `\n- Current Plan ID: ${instance_plan_id}` : ''}${allStepsContext}${activeStepContext}${lastCompletedPlanContext}${activeRequirementId ? `\n- Current Requirement ID: ${activeRequirementId}${requirementIdWarning}` : ''}\n`;

  let extraContextInstruction = '';
  let isAudienceGeneration = false;
  let isTextNodeOnly = false;
  
  if (contextString) {
    try {
      const parsedContext = JSON.parse(contextString);
      
      // Fallback: If parsedContext doesn't have nodeType, but we know it's a publish node because it has publish_destinations
      const isPublishNode = parsedContext.nodeType === 'publish' || (parsedContext.publish_destinations && Array.isArray(parsedContext.publish_destinations));
      
      if (parsedContext.mediaType === 'audience' || parsedContext.output_type === 'audience') {
        isAudienceGeneration = true;
      }
      
      if (parsedContext.mediaType === 'text' || parsedContext.output_type === 'text') {
        // Exclude the 'publish' node from being treated as text-only generation.
        // A publish node often has media_type: 'text' to indicate what kind of asset to publish, 
        // but it is an action node that MUST use tools.
        if (!isPublishNode) {
          isTextNodeOnly = true;
        }
      }
      
      if (parsedContext.parameters) {
        extraContextInstruction = `\n\n⚠️ IMPORTANT CONTEXT PARAMETERS (YOU MUST RESPECT THESE IN YOUR TOOL CALLS):\n${JSON.stringify(parsedContext.parameters, null, 2)}\nIf you are generating media, YOU MUST use these exact parameters (duration, aspect_ratio, etc).`;
      } else {
        extraContextInstruction = `\n\n⚠️ IMPORTANT CONTEXT:\n${contextString}`;
      }
      
      if (isPublishNode) {
        const destStr = Array.isArray(parsedContext.publish_destinations) 
          ? JSON.stringify(parsedContext.publish_destinations) 
          : '[]';
        extraContextInstruction += `\n\n📢 PUBLISH NODE TASK:
CRITICAL: You are inside a PUBLISH node. Your goal is to PUBLISH content to the selected social networks.
1. You MUST use the \`publish\` tool via \`tools\`.
2. You MUST use these exact social networks/destinations: ${destStr}. DO NOT invent or publish to other networks.
3. The publish tool is MULTI-CHANNEL. You MUST combine and group compatible content into a SINGLE tool call whenever possible (e.g., identical posts going to Facebook and LinkedIn).
4. If the content significantly differs between channels (e.g., a short Tweet vs. a long Newsletter), you MUST make SEPARATE calls to the publish tool for each distinct content variation.
5. Make sure the content matches the context of the conversation.`;
      }
      
      if (isAudienceGeneration) {
        const channelsStr = Array.isArray(parsedContext.audience_channels) && parsedContext.audience_channels.length > 0
          ? `\nREQUIRED FILTERS: You must apply these channel filters to the audience tool using the 'channels' array parameter: ${JSON.stringify(parsedContext.audience_channels)}.`
          : '';
          
        extraContextInstruction += `\n\n🎯 AUDIENCE GENERATION TASK:
CRITICAL: Your primary task is to CREATE a persistent audience.
1. You MUST use the \`audience\` tool via \`tools\` with action='create'.
2. Do NOT use the \`leads\` tool to simply list or display leads. You must CREATE the audience.
3. You MUST return the resulting \`audience_id\` in your final response.${channelsStr}`;
      }
    } catch {
      extraContextInstruction = `\n\n⚠️ IMPORTANT CONTEXT:\n${contextString}`;
    }
  }

  const nodeModeInstruction = instanceNodeId
    ? `\n\n⚠️ VISUAL NODE MODE (IMPRENTA): You are executing inside a visual node graph. Users expect IMMEDIATE media/asset generation results. DO NOT update or create \`instance_plan\` or \`requirements\`. You are allowed to use read-only/search tools to gather context even in text-only mode.${
        isTextNodeOnly
          ? `\nCRITICAL: This is a TEXT-ONLY node (output_type: text). Your goal is ONLY to generate, brainstorm, or write text. DO NOT call any generation, publishing, or messaging tools (like sendBulkMessages, publish, or whatsappTemplate). Just return the requested text directly, but feel free to use reading/searching tools to get info first.`
          : `\nCRITICAL: Even if the user asks you to "improve the prompt", "write a script", or "rewrite", you MUST NOT stop at just returning text. You MUST take that improved text and IMMEDIATELY pass it into the appropriate generation tool (via \`tools\`) within this exact same response. Your final output MUST include calling the tool to generate the actual asset (video, image, audio, etc).`
      }${extraContextInstruction}`
    : extraContextInstruction;
  const reinforcedNodeModeInstruction = [
    nodeModeInstruction,
    uiMediaContract?.instruction,
  ].filter(Boolean).join('\n');

  // When system prompt is "plan", instruct the assistant to always use instance_plan (indication only, not deterministic code)
  const planModeInstruction =
    systemPrompt?.toLowerCase().trim() === 'plan' && !hasLinkedRequirement
      ? `\n\n📋 PLAN MODE: Your system prompt is set to "plan". You MUST always use the instance_plan tool: create or list the execution plan (action "create" or "list") as appropriate, then execute steps with action "execute_step" when carrying out the plan. Do not skip using instance_plan when the user asks for planning or task execution.

BREAKING DOWN THE PLAN:
- When creating or updating a plan, BREAK DOWN the objective into specific, actionable execution steps (e.g., 1. investigate/setup, 2. core logic, 3. tests). Do NOT just copy the user's prompt or task title into a single step.

PLAN vs STEPS:
- If the user's request describes a DIFFERENT plan (new objective, new scope, or different approach than the previous plan): use action "create" to create a NEW plan. Do not reuse or update the old plan.
- If the user only adds or requests NEW STEPS within the same plan (same objective/scope): use action "list" to get the current plan, then use action "update" to add or modify steps and set status to "in_progress" to reopen the plan. Do not create a new plan in this case.

EXECUTION:
- To execute a step using action "execute_step", you NEED the step id. You MUST use the step IDs provided in the INSTANCE CONTEXT above. DO NOT use action "list" to search for step IDs.`
      : '';

  const activePlanInstruction = 
    systemPrompt?.toLowerCase().trim() === 'plan' && hasLinkedRequirement
      ? `\n\n⚠️ IMPORTANT PLAN CONTEXT: There is an active plan in progress, but it is assigned to another agent. You can monitor or update its status using the \`requirement_status\` and \`requirements\` tools, but do NOT execute the plan steps directly.`
      : '';

  const whatsappInstruction = `
📱 WHATSAPP TOOLS (sendWhatsApp and whatsappTemplate):
- To send a WhatsApp message: use tools to call sendWhatsApp with phone_number (international format, e.g. +34912345678, no spaces) and message. Optionally pass conversation_id, lead_id for tracking, and media_urls (array of strings) if you want to attach images, videos, audio, or PDFs.
- If sendWhatsApp returns template_required: true (conversation is outside the 24h reply window), you MUST use whatsappTemplate next via tools:
  1) Call tools with action "call", name "whatsappTemplate", and args { action: "create_template", phone_number, message } (and conversation_id if available). The message MAY contain merge tokens (e.g. {{lead.name}}, {{site.name}}); they will be rewritten to numeric placeholders ({{1}}, {{2}}, ...) automatically and returned as \`placeholder_map\`. If the result includes template_id, then
  2) Call tools with action "call", name "whatsappTemplate", and args { action: "send_template", template_id, phone_number, original_message }. When \`has_variables\` is true (i.e. \`placeholder_map\` is non-empty), you MUST also pass either \`lead_id\` (preferred — variables are resolved automatically from the lead row + site name) or \`variables\` as a map like { "1": "Jane", "2": "Acme" }. Do NOT call send_template without variables when placeholder_map is non-empty.
- If create_template returns template_required: false, the conversation is within 24h—use sendWhatsApp instead; do not use send_template.
- For bulk/campaign sends, prefer \`publish\` (with audience_id + channel "whatsapp") or \`sendBulkMessages\` via tools: they create a SINGLE template for the campaign and queue per-lead variables automatically. Do NOT create a new template per recipient.
- Always use international phone format (country code + number, e.g. +1..., +34..., +52...).`;

  const generationInstruction = `
🎙️ MULTIMEDIA GENERATION:
- When the user asks to generate AUDIO, a song, a rap, or a voiceover, you MUST call the \`generate_audio\` tool via tools to fulfill the request. If you are asked to write the lyrics/script, write them and immediately pass them into the \`generate_audio\` tool within the same response. Do NOT just output the text without calling the tool.
- When generating IMAGES, you MUST use the \`generate_image\` tool via tools.
- When generating VIDEO, you MUST use the \`generate_video\` tool via tools. If there are Image URLs for reference in the context or user messages, you MUST pass them to the \`reference_images\` parameter array.
- CRITICAL: Never reply with just the lyrics or script if the user requested a song or audio. You MUST use the \`generate_audio\` tool and return the resulting URL.`;

  const toolsRouterInstruction = `
🧰 TOOL DISCOVERY & EXECUTION (tools):
Most capabilities (media, messaging, CRM, commerce, social, content, infra, research, ui) are hidden behind the \`tools\` router to save context.
- Use \`tools({ action: "list" })\` to see every routed tool grouped by category.
- Use \`tools({ action: "describe", name: "<tool>" })\` to get the exact parameters schema + expected_use for a specific tool before calling it.
- Use \`tools({ action: "call", name: "<tool>", args: { ... } })\` to execute it. If args are invalid the error includes the parameters schema so you can auto-correct and retry.
- Examples: calendars, catalog_commerce, checkout, quotations, generate_image, sendEmail, leads, sales, publish, content, webSearch — ALL live behind tools. The router is the only way to reach them.
- PUBLISHING CONTENT: The \`publish\` tool is multi-channel. You MUST combine compatible content across networks into a SINGLE tool call, but make SEPARATE calls if the content differs significantly between channels (e.g. short tweet vs newsletter).
- To find people, working hours, team calendars, or reservable services: \`tools\` → \`calendars\` \`action="list"\`. Do not guess tool names for horarios.
- Core tools like instance_plan, requirement_status, requirements, and skill_lookup are directly available and NOT routed.`;

  const skillLookupInstruction = `
🧠 SKILL DISCOVERY (skill_lookup):
For any non-trivial request (especially catalog, commerce, products, quotes, checkout, reservations, slots, expenses, salaries), you MUST call \`skill_lookup\` with \`action="search"\` using English keywords (e.g. "catalog products marketplace commerce reservations slots checkout" or "expense salary payroll transactions"), then \`action="get"\` for matches such as "makinari-commerce" or "makinari-expenses".
Follow the loaded SKILL.md playbooks before calling tools via \`tools\`. \`skill_lookup\` is directly available (not routed).`;

  const commerceInstruction = `
🛒 COMMERCE & CATALOG:
- Create/update catalog items via \`tools\` → \`catalog_commerce\` (not free-text product lists).
- Prefer skill \`makinari-commerce\` for the full protocol, including catalog capacity slots (reservations).
- Purchasable flows use \`checkout\`, not legacy \`sales\` / \`sales_order\`.
- Subscriptions: Use \`tools\` → \`subscriptions\` to read, list, create or update a user's active subscriptions. You CAN manually create a subscription if the user paid outside of Stripe.
- General expenses, salaries, and payroll use \`tools\` → \`transactions\` (skill \`makinari-expenses\`). Vendor bills / PO use \`purchases\` (skill \`makinari-purchases\`). Do not mix them.
- When an uploaded image is attached, use the HTTP URLs from the CRITICAL list as product image fields / references.`;

  const isWorkflowMode = (systemPrompt || '').includes('WORKFLOW MODE');

  const combinedSystemPrompt = isWorkflowMode
    ? [
        systemPrompt || '',
        instanceContext,
        toolsRouterInstruction,
        skillLookupInstruction,
        requiredSkillsPrompt(selectedSkills),
      ].filter(Boolean).join('\n')
    : [
    agentBackground,
    instanceContext,
    reinforcedNodeModeInstruction,
    baseSystemPrompt,
    toolsContext,
    systemPrompt || '',
    toolsRouterInstruction,
    skillLookupInstruction,
    requiredSkillsPrompt(selectedSkills),
    commerceInstruction,
    planModeInstruction,
    activePlanInstruction,
    whatsappInstruction,
    generationInstruction,
    memoriesContext,
    instanceNodeId || !historyContext ? '' : `INSTANCE_HISTORY_START\n${historyContext}\nINSTANCE_HISTORY_END`,
    requirementStatusContext,
    progressContext,
    backlogContext,
    getRequirementWorkflowInstruction(hasLinkedRequirement),
    instanceNodeId ? '' : assetsContext,
    ICP_CATEGORY_IDS_INSTRUCTION,
    BOOKING_ROUTING_INSTRUCTION,
    EXPENSES_VS_PURCHASES_INSTRUCTION,
    agentType === 'gear' ? GEAR_PROJECT_SWITCH_INSTRUCTION : '',
    EXTERNAL_API_INTEGRATION_INSTRUCTION,
    renameInstruction,
    toolsWithImageGeneration.length > 0 ? `\n\n🔧 CUSTOM TOOLS: ${toolsWithImageGeneration.length} additional tool(s)` : ''
  ].filter(Boolean).join('\n');

  // Clean base64 data
  let finalSystemPrompt = combinedSystemPrompt;
  if (combinedSystemPrompt.includes('base64')) {
    finalSystemPrompt = combinedSystemPrompt.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA_REMOVED]');
  }

  return {
    instance,
    systemPrompt: finalSystemPrompt,
    customTools, // Pass definitions, not instantiated tools
    agentType,
    userPhone,
    initialMessage: message,
    executionOptions: {
      use_sdk_tools: shouldUseSDKTools && !useAssistantOnly,
      provider: finalProvider,
      ai_provider: finalProvider,
      instance_id: instanceId,
      site_id: siteId,
      user_id: userId,
      ...(activeRequirementId ? { requirement_id: activeRequirementId } : {}),
    },
    imageAssets,
    hasLinkedRequirement,
    instanceNodeId,
    expectedResultsAmount: expectedResultsAmount || 1,
    toolOverrides: uiMediaContract?.toolOverrides ?? toolOverrides,
    uiMediaOutputType: uiMediaContract?.outputType,
    selectedSkills,
    approvedImport,
  };
}
