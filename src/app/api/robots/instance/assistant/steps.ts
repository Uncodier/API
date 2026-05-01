'use step';

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { executeAssistantStep } from '@/lib/services/robot-instance/assistant-executor';
import { InstanceAssetsService } from '@/lib/services/robot-instance/InstanceAssetsService';
import {
  fetchMemoriesContext,
  generateAgentBackground,
  getAssistantTools,
  determineInstanceCapabilities,
  ICP_CATEGORY_IDS_INSTRUCTION,
  getSandboxRequirementWorkflowInstruction,
} from './utils';

export interface AssistantContext {
  instance: any;
  systemPrompt: string;
  customTools: any[];
  agentType?: string;
  userPhone?: string;
  executionOptions: {
    use_sdk_tools: boolean;
    /** Logging/credits label (NOT the underlying LLM provider). */
    provider: 'azure' | 'openai' | 'gemini';
    instance_id: string;
    site_id: string;
    user_id: string;
    /** Optional LLM provider override (gemini | azure | openai). Defaults to env AI_PROVIDER. */
    ai_provider?: 'gemini' | 'azure' | 'openai';
    /** Optional LLM model override. Defaults to env AI_MODEL / provider default. */
    ai_model?: string;
  };
  initialMessage: string;
  imageAssets: { url: string; fileType: string }[];
  hasLinkedRequirement: boolean;
  instanceNodeId?: string;
  expectedResultsAmount: number;
}

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
  expectedResultsAmount?: number
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
  const { data: historicalLogs } = await supabaseAdmin
    .from('instance_logs')
    .select('log_type, message, created_at, tool_name, tool_result')
    .eq('instance_id', instanceId)
    .in('log_type', ['user_action', 'agent_action', 'execution_summary', 'tool_call'])
    .order('created_at', { ascending: true })
    .limit(500);

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
     // finalProvider = 'azure'; // Force Azure for assistant-only
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

  // Fetch requirement_status context
  const { data: requirementStatuses } = await supabaseAdmin
    .from('requirement_status')
    .select('*')
    .eq('instance_id', instanceId)
    .order('created_at', { ascending: false })
    .limit(10);
    
  let requirementStatusContext = '';
  if (requirementStatuses && requirementStatuses.length > 0) {
    requirementStatusContext = '\n\n📋 REQUIREMENT STATUS CONTEXT:\n';
    requirementStatusContext += JSON.stringify(requirementStatuses, null, 2);
    requirementStatusContext += '\n\n💡 WHEN CHANGES ARE REQUESTED: If the user requests changes, you MUST use the requirements tool (action="update") to update the requirement instructions with the new requests and set its status to "in-progress". Then, use the requirement_status tool (action="create") to log that the requirement is back in progress.';
  }

  const hasLinkedRequirement = !!(requirementStatuses && requirementStatuses.length > 0);

  // Generate prompts
  const agentBackground = await generateAgentBackground(siteId);
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

  const instanceContext = `\n\n🆔 INSTANCE CONTEXT:\n- Instance ID: ${instanceId}\n- Site ID: ${siteId}\n- User ID: ${userId}\n`;

  // When system prompt is "plan", instruct the assistant to always use instance_plan (indication only, not deterministic code)
  const planModeInstruction =
    systemPrompt?.toLowerCase().trim() === 'plan' && !hasLinkedRequirement
      ? `\n\n📋 PLAN MODE: Your system prompt is set to "plan". You MUST always use the instance_plan tool: create or list the execution plan (action "create" or "list") as appropriate, then execute steps with action "execute_step" when carrying out the plan. Do not skip using instance_plan when the user asks for planning or task execution.

BREAKING DOWN THE PLAN:
- When creating or updating a plan, BREAK DOWN the objective into specific, actionable execution steps (e.g., 1. investigate/setup, 2. core logic, 3. tests). Do NOT just copy the user's prompt or task title into a single step.

PLAN vs STEPS:
- If the user's request describes a DIFFERENT plan (new objective, new scope, or different approach than the previous plan): use action "create" to create a NEW plan. Do not reuse or update the old plan.
- If the user only adds or requests NEW STEPS within the same plan (same objective/scope): use action "list" to get the current plan, then use action "update" to add or modify steps and set status to "in_progress" to reopen the plan. Do not create a new plan in this case.`
      : '';

  const activePlanInstruction = 
    systemPrompt?.toLowerCase().trim() === 'plan' && hasLinkedRequirement
      ? `\n\n⚠️ IMPORTANT PLAN CONTEXT: There is an active plan in progress, but it is assigned to another agent. You can monitor or update its status using the \`requirement_status\` and \`requirements\` tools, but do NOT execute the plan steps directly.`
      : '';

  const whatsappInstruction = `
📱 WHATSAPP TOOLS (sendWhatsApp and whatsappTemplate):
- To send a WhatsApp message: use tool_lookup to call sendWhatsApp with phone_number (international format, e.g. +34912345678, no spaces) and message. Optionally pass conversation_id, lead_id for tracking, and media_urls (array of strings) if you want to attach images, videos, audio, or PDFs.
- If sendWhatsApp returns template_required: true (conversation is outside the 24h reply window), you MUST use whatsappTemplate next via tool_lookup:
  1) Call tool_lookup with action "call", name "whatsappTemplate", and args { action: "create_template", phone_number, message } (and conversation_id if available). The message MAY contain merge tokens (e.g. {{lead.name}}, {{site.name}}); they will be rewritten to numeric placeholders ({{1}}, {{2}}, ...) automatically and returned as \`placeholder_map\`. If the result includes template_id, then
  2) Call tool_lookup with action "call", name "whatsappTemplate", and args { action: "send_template", template_id, phone_number, original_message }. When \`has_variables\` is true (i.e. \`placeholder_map\` is non-empty), you MUST also pass either \`lead_id\` (preferred — variables are resolved automatically from the lead row + site name) or \`variables\` as a map like { "1": "Jane", "2": "Acme" }. Do NOT call send_template without variables when placeholder_map is non-empty.
- If create_template returns template_required: false, the conversation is within 24h—use sendWhatsApp instead; do not use send_template.
- For bulk/campaign sends, prefer \`publish\` (with audience_id + channel "whatsapp") or \`sendBulkMessages\` via tool_lookup: they create a SINGLE template for the campaign and queue per-lead variables automatically. Do NOT create a new template per recipient.
- Always use international phone format (country code + number, e.g. +1..., +34..., +52...).`;

  const generationInstruction = `
🎙️ MULTIMEDIA GENERATION:
- When the user asks to generate AUDIO, a song, a rap, or a voiceover, you MUST call the \`generate_audio\` tool via tool_lookup to fulfill the request. If you are asked to write the lyrics/script, write them and immediately pass them into the \`generate_audio\` tool within the same response. Do NOT just output the text without calling the tool.
- When generating IMAGES, you MUST use the \`generate_image\` tool via tool_lookup.
- When generating VIDEO, you MUST use the \`generate_video\` tool via tool_lookup.
- CRITICAL: Never reply with just the lyrics or script if the user requested a song or audio. You MUST use the \`generate_audio\` tool and return the resulting URL.`;

  const toolLookupInstruction = `
🧰 TOOL DISCOVERY & EXECUTION (tool_lookup):
Most capabilities (media, messaging, CRM, social, content, infra, research) are hidden behind the \`tool_lookup\` router to save context.
- Use \`tool_lookup({ action: "list" })\` to see every routed tool grouped by category.
- Use \`tool_lookup({ action: "describe", name: "<tool>" })\` to get the exact parameters schema + expected_use for a specific tool before calling it.
- Use \`tool_lookup({ action: "call", name: "<tool>", args: { ... } })\` to execute it. If args are invalid the error includes the parameters schema so you can auto-correct and retry.
- Examples: generate_image, sendEmail, leads, sales, socialMediaPublish, content, webSearch — ALL live behind tool_lookup. The router is the only way to reach them.
- Core tools like instance_plan, requirement_status, requirements, and skill_lookup are directly available and NOT routed.`;

  const combinedSystemPrompt = [
    agentBackground,
    instanceContext,
    baseSystemPrompt,
    toolsContext,
    systemPrompt || '',
    toolLookupInstruction,
    planModeInstruction,
    activePlanInstruction,
    whatsappInstruction,
    generationInstruction,
    memoriesContext,
    historyContext,
    requirementStatusContext,
    getSandboxRequirementWorkflowInstruction(hasLinkedRequirement),
    assetsContext,
    ICP_CATEGORY_IDS_INSTRUCTION,
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
) {
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

  // Execute one step
  const result = await executeAssistantStep(messages, context.instance, options);

  return result;
}
