'use step';

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { InstanceAssetsService } from '@/lib/services/robot-instance/InstanceAssetsService';
import {
  dehydrateMessageImages,
  hydrateMessageImages,
} from '@/lib/services/robot-instance/vision-message-images';
import {
  fetchMemoriesContext,
  generateAgentBackground,
  getAssistantTools,
  determineInstanceCapabilities,
  ICP_CATEGORY_IDS_INSTRUCTION,
  getRequirementWorkflowInstruction,
  BOOKING_ROUTING_INSTRUCTION,
  EXPENSES_VS_PURCHASES_INSTRUCTION,
  GEAR_PROJECT_SWITCH_INSTRUCTION,
} from './utils';

import type { AssistantContext } from './types';

// Step 1: Prepare context (fetch data, build prompts)
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
  contextString?: string
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

  // Fetch historical logs
  const { data: rawHistoricalLogs } = await supabaseAdmin
    .from('instance_logs')
    .select('log_type, message, created_at, tool_name, tool_result')
    .eq('instance_id', instanceId)
    .in('log_type', ['user_action', 'agent_action', 'execution_summary', 'tool_call'])
    .order('created_at', { ascending: false })
    .limit(50);

  const historicalLogs = rawHistoricalLogs ? [...rawHistoricalLogs].reverse() : [];

  // Build history context
  let historyContext = '';
  if (historicalLogs && historicalLogs.length > 0) {
    historyContext = '\n\n📋 CONVERSATION HISTORY:\n';
    historicalLogs.forEach((log) => {
      const timestamp = new Date(log.created_at).toLocaleTimeString();
      const role = log.log_type === 'user_action' ? 'User' : 'Assistant';
      
      if (log.log_type === 'tool_call' && log.tool_name && log.tool_result) {
        if (['generate_image', 'generate_video'].includes(log.tool_name)) {
            const toolResult = log.tool_result;
            const outputKey = log.tool_name === 'generate_image' ? 'images' : 'videos';
            if (toolResult.success && toolResult.output && toolResult.output[outputKey]) {
              const urls = toolResult.output[outputKey].map((item: any) => item.url).filter(Boolean);
              if (urls.length > 0) {
                historyContext += `[${timestamp}] ${role}: Generated ${log.tool_name} - URLs: ${urls.join(', ')}\n`;
              } else {
                historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
              }
            } else {
              historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
            }
        } else {
          historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
        }
      } else {
        historyContext += `[${timestamp}] ${role}: ${log.message.substring(0, 150)}${log.message.length > 150 ? '...' : ''}\n`;
      }
    });
  }

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

  // Fetch requirement_status context.
  //
  // CRITICAL: `requirement_status` is append-only and shared across every
  // requirement that ever ran in this instance. We used to pick the latest row
  // blindly and tell the assistant "Current Requirement ID: <last>", which
  // caused cross-project contamination — a fresh conversation in a reused
  // instance would inherit the previous requirement (and, via the sandbox
  // bootstrap, that requirement's snapshot/preview).
  //
  // Now we only treat a requirement as "active" when:
  //   (a) the requirement row itself is still open
  //       (`status` in 'pending' / 'in-progress' / 'blocked'), AND
  //   (b) the latest status row for that requirement is non-terminal.
  // Terminal requirements never leak into the new prompt.
  const { data: requirementStatuses } = await supabaseAdmin
    .from('requirement_status')
    .select('*')
    .eq('instance_id', instanceId)
    .order('created_at', { ascending: false })
    .limit(10);

  let requirementStatusContext = '';
  let activeRequirementId: string | null = null;
  if (requirementStatuses && requirementStatuses.length > 0) {
    const TERMINAL_STAGES = new Set(['done', 'completed', 'cancelled', 'failed']);
    const candidateId = requirementStatuses[0].requirement_id;
    const latestStage = String(requirementStatuses[0].stage || '').toLowerCase();

    if (candidateId && !TERMINAL_STAGES.has(latestStage)) {
      const { data: reqRow } = await supabaseAdmin
        .from('requirements')
        .select('status, title, description, instructions, type, priority')
        .eq('id', candidateId)
        .maybeSingle();
      const reqStatus = String(reqRow?.status || '').toLowerCase();
      const isOpen =
        !reqStatus || reqStatus === 'pending' || reqStatus === 'in-progress' || reqStatus === 'blocked';
      if (isOpen) {
        activeRequirementId = candidateId;
        
        requirementStatusContext = '\n\n📋 CURRENT REQUIREMENT CONTEXT:\n';
        requirementStatusContext += JSON.stringify(reqRow, null, 2);
      } else {
        console.log(
          `[AssistantContext] Skipping activeRequirementId=${candidateId}: requirement is terminal (${reqStatus}). Avoiding cross-project context leak.`,
        );
      }
    }

    if (activeRequirementId) {
      requirementStatusContext += '\n\n📋 REQUIREMENT STATUS HISTORY:\n';
      requirementStatusContext += JSON.stringify(requirementStatuses, null, 2);
      requirementStatusContext += '\n\n💡 WHEN CHANGES ARE REQUESTED: If the user requests changes, you MUST use the requirements tool (action="update") to update the requirement instructions with the new requests and set its status to "in-progress". Then, use the requirement_status tool (action="create") to log that the requirement is back in progress.';
    }
  }

  // Fetch requirement progress log and backlog if linked
  let progressContext = '';
  let backlogContext = '';
  if (activeRequirementId) {
    const { data: reqData } = await supabaseAdmin
      .from('requirements')
      .select('progress, backlog')
      .eq('id', activeRequirementId)
      .single();
      
    if (reqData && reqData.progress && Array.isArray(reqData.progress) && reqData.progress.length > 0) {
      // Get the last 5 progress entries
      const recentProgress = reqData.progress.slice(-5);
      progressContext = '\n\n📋 RECENT REQUIREMENT PROGRESS:\n';
      progressContext += JSON.stringify(recentProgress, null, 2);
    }

    if (reqData && reqData.backlog && reqData.backlog.items && Array.isArray(reqData.backlog.items)) {
      const inProgressItem = reqData.backlog.items.find((item: any) => item.status === 'in_progress');
      if (inProgressItem) {
        backlogContext = '\n\n📋 CURRENT BACKLOG ITEM (IN_PROGRESS):\n';
        backlogContext += JSON.stringify(inProgressItem, null, 2);
      }
    }
  }

  // Fetch active instance plan context
  const { data: lastPlans } = await supabaseAdmin
    .from('instance_plans')
    .select('*')
    .eq('instance_id', instanceId)
    .in('status', ['pending', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(1);

  let instance_plan_id = null;
  let activeStepContext = '';
  let allStepsContext = '';
  let lastCompletedPlanContext = '';
  
  if (lastPlans && lastPlans.length > 0) {
    const activePlan = lastPlans[0];
    
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

  const hasLinkedRequirement = !!(requirementStatuses && requirementStatuses.length > 0);

  // Generate prompts
  const agentBackground = await generateAgentBackground(siteId, userId);
  const memoriesContext = await fetchMemoriesContext(siteId, userId, instanceId);
  
  // Get tools list just for counting/prompt purposes here
  // We do NOT pass these instantiated tools in the return value to avoid serialization issues
  const toolsWithImageGeneration = getAssistantTools(siteId, userId, instanceId, customTools, agentType, userPhone);
  
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

  const instanceContext = `\n\n🆔 INSTANCE CONTEXT:\n- Instance ID: ${instanceId}\n- Site ID: ${siteId}\n- User ID: ${userId}${instance_plan_id ? `\n- Current Plan ID: ${instance_plan_id}` : ''}${allStepsContext}${activeStepContext}${lastCompletedPlanContext}${activeRequirementId ? `\n- Current Requirement ID: ${activeRequirementId}` : ''}\n`;

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
    ? `\n\n⚠️ VISUAL NODE MODE (IMPRENTA): You are executing inside a visual node graph. Users expect IMMEDIATE media/asset generation results. DO NOT update or create \`instance_plan\` or \`requirements\`.${
        isTextNodeOnly
          ? `\nCRITICAL: This is a TEXT-ONLY node (output_type: text). Your goal is ONLY to generate, brainstorm, or write text. DO NOT call any generation, publishing, or messaging tools (like sendBulkMessages, publish, or whatsappTemplate). Just return the requested text directly.`
          : `\nCRITICAL: Even if the user asks you to "improve the prompt", "write a script", or "rewrite", you MUST NOT stop at just returning text. You MUST take that improved text and IMMEDIATELY pass it into the appropriate generation tool (via \`tools\`) within this exact same response. Your final output MUST include calling the tool to generate the actual asset (video, image, audio, etc).`
      }${extraContextInstruction}`
    : extraContextInstruction;

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
- Examples: calendars, catalog_commerce, checkout, quotations, generate_image, sendEmail, leads, sales, socialMediaPublish, content, webSearch — ALL live behind tools. The router is the only way to reach them.
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
- General expenses, salaries, and payroll use \`tools\` → \`transactions\` (skill \`makinari-expenses\`). Vendor bills / PO use \`purchases\` (skill \`makinari-purchases\`). Do not mix them.
- When an uploaded image is attached, use the HTTP URLs from the CRITICAL list as product image fields / references.`;

  const isWorkflowMode = (systemPrompt || '').includes('WORKFLOW MODE');

  const combinedSystemPrompt = isWorkflowMode
    ? [
        systemPrompt || '',
        instanceContext,
        toolsRouterInstruction,
        skillLookupInstruction,
      ].filter(Boolean).join('\n')
    : [
    agentBackground,
    instanceContext,
    nodeModeInstruction,
    baseSystemPrompt,
    toolsContext,
    systemPrompt || '',
    toolsRouterInstruction,
    skillLookupInstruction,
    commerceInstruction,
    planModeInstruction,
    activePlanInstruction,
    whatsappInstruction,
    generationInstruction,
    memoriesContext,
    historyContext,
    requirementStatusContext,
    progressContext,
    backlogContext,
    getRequirementWorkflowInstruction(hasLinkedRequirement),
    assetsContext,
    ICP_CATEGORY_IDS_INSTRUCTION,
    BOOKING_ROUTING_INSTRUCTION,
    EXPENSES_VS_PURCHASES_INSTRUCTION,
    agentType === 'gear' ? GEAR_PROJECT_SWITCH_INSTRUCTION : '',
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
    },
    imageAssets,
    hasLinkedRequirement,
    instanceNodeId,
    expectedResultsAmount: expectedResultsAmount || 1,
  };
}

// Step 2: Execute one turn of the assistant
export async function processAssistantTurn(
  context: AssistantContext,
  messages: any[]
): Promise<any> {
  'use step';

  // Re-instantiate tools here inside the step where they will be used
  const fullTools = getAssistantTools(
    context.executionOptions.site_id,
    context.executionOptions.user_id,
    context.executionOptions.instance_id,
    context.customTools,
    context.agentType,
    context.userPhone
  );

  // Re-assemble execution options
  const options = {
    ...context.executionOptions,
    system_prompt: context.systemPrompt,
    custom_tools: fullTools,
    instance_node_id: context.instanceNodeId,
    expected_results_amount: context.expectedResultsAmount,
  };

  // Hydrate HTTP image_url → data URLs inside THIS step (same process as the LLM).
  // Large base64 must not cross Vercel Workflow step boundaries.
  const hydratedMessages = await hydrateMessageImages(messages);

  const result = await executeAssistantStep(hydratedMessages, context.instance, options);

  // Shrink payload before returning across the workflow step boundary
  if (result?.messages) {
    result.messages = dehydrateMessageImages(result.messages);
  }

  return result;
}
