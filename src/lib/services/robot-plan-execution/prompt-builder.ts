/**
 * Prompt Builder Service
 * Builds system and user prompts with context for agent execution
 */

import { PLAN_EXECUTION_SYSTEM_PROMPT } from './constants';

/**
 * Build system prompt with context
 */
export function buildSystemPrompt(
  logContext: string,
  sessionsContext: string,
  sessionsRequirementContext: string
): string {
  const currentDate = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  const promptWithDate = PLAN_EXECUTION_SYSTEM_PROMPT.replace('[DATE_PLACEHOLDER]', currentDate);
  
  const systemPromptWithContext = `${promptWithDate}

HISTORICAL CONTEXT:
Here is the conversation history for this instance (agent and user interactions):

${logContext}

END OF HISTORICAL CONTEXT

AUTHENTICATION SESSIONS CONTEXT:
${sessionsContext}
${sessionsRequirementContext}

🔐 CRITICAL SESSION INTEGRATION INSTRUCTIONS:

**MANDATORY SESSION VERIFICATION:**
- ALWAYS check session availability BEFORE attempting platform actions
- If you need authentication that doesn't exist, respond with: "session needed [platform] [domain]"
- Use existing sessions when available by referencing them in your actions
- If a session appears invalid or expired, request a new one

**SESSION STATUS RESPONSES:**
- "session needed facebook facebook.com" - when you need Facebook authentication
- "session needed linkedin linkedin.com" - when you need LinkedIn authentication  
- "session needed google google.com" - when you need Google authentication
- "new [platform] session acquired" - when you successfully obtain authentication

🚨 REMEMBER: Session issues should be resolved BEFORE attempting the step completion. If you cannot get required authentication, mark the step as failed with a clear explanation.

END OF SESSIONS CONTEXT`;

  return systemPromptWithContext;
}

/**
 * Build user prompt for step execution
 */
export function buildUserPrompt(
  plan: any,
  currentStep: any,
  allSteps: any[]
): string {
  const completedSteps = allSteps.filter((step: any) => ['completed', 'failed', 'blocked'].includes(step.status));
  const planCompletedPercentage = Math.round((completedSteps.length / allSteps.length) * 100);

  const planPrompt = `🎯 SINGLE STEP EXECUTION TASK

PLAN TITLE: ${plan.title}
PLAN STATUS: ${plan.status}
PLAN PROGRESS: Step ${currentStep.order} of ${allSteps.length} (${planCompletedPercentage}% complete)

🚨🚨🚨 YOU ARE WORKING ON ONE STEP ONLY 🚨🚨🚨

CURRENT STEP: ${currentStep.order}
STEP STATUS: ${currentStep.status}
STEP TITLE: ${currentStep.title}
STEP DESCRIPTION: ${currentStep.description || currentStep.instructions || 'No description provided'}

🧠 CONTEXT AWARENESS:
- Focus on completing the current step efficiently
- Use available authentication sessions when needed
- If authentication is required, use the provided session information

🛑 DO NOT THINK ABOUT FUTURE STEPS
🛑 DO NOT EXECUTE MULTIPLE STEPS
🛑 FOCUS ONLY ON CURRENT STEP ${currentStep.order}

📋 YOUR TASK:
Execute the actions required to complete ONLY this step: "${currentStep.title}"

🚨 MANDATORY COMPLETION RULE:
The MOMENT you finish this step, you MUST provide a structured response with:

- event: "step_completed"
- step: ${currentStep.order}
- assistant_message: "Brief description of what was accomplished"

🚨 IF THE STEP FAILS, provide:
- event: "step_failed"
- step: ${currentStep.order}
- assistant_message: "Brief description of why it failed"

🚨 IF YOU NEED AUTHENTICATION, provide:
- event: "session_needed"
- step: ${currentStep.order}
- assistant_message: "Brief description of what authentication is needed"

⚠️⚠️⚠️ CRITICAL ENFORCEMENT ⚠️⚠️⚠️

1. Work ONLY on step ${currentStep.order}
2. When step ${currentStep.order} is complete, IMMEDIATELY provide structured response
3. DO NOT continue to any other step
4. DO NOT execute multiple actions without reporting progress
5. The structured response is MANDATORY and automatically validated

STEP INSTRUCTIONS: ${currentStep.description || currentStep.instructions || 'Complete the step as described in the title'}

═══════════════════════════════════════════════════════════════════
🖥️ COMPUTER TOOL USAGE - CRITICAL BEST PRACTICES
═══════════════════════════════════════════════════════════════════

**🚨 THIS IS THE MOST IMPORTANT SECTION - READ CAREFULLY 🚨**

The **computer** tool allows you to interact with the Ubuntu desktop using coordinates, mouse, and keyboard.

Available actions:
- **take_screenshot** - Capture current screen state
- **click** - Click at coordinate [X,Y]
- **double_click** - Double click at coordinate
- **mouse_move** - Move mouse to coordinate
- **type** - Type text (in focused field)
- **press_key** - Press keyboard keys (e.g. ["CTRL", "L"], ["Return"])
- **scroll** - Scroll up/down

**Core Principles:**

1. **BALANCE SCREENSHOTS WITH ACTION**
   - Take screenshot to see current state
   - Analyze what you see
   - TAKE ACTION to make progress (click, type, navigate)
   - Take screenshot to verify
   - ❌ DON'T: screenshot → screenshot → screenshot (no progress)
   - ✅ DO: screenshot → ACTION → screenshot → ACTION

2. **USE COORDINATES FROM SCREENSHOTS**
   - Look at screenshot to find element position
   - Identify X,Y coordinates (center of element)
   - Use those coordinates for click
   - Example: Button at (640, 400) → click: coordinate=[640, 400]

3. **NAVIGATION PATTERN**
   - press_key: ["CTRL", "L"] → Focus address bar
   - type: "https://example.com" → Type URL
   - press_key: ["Return"] → Navigate
   - take_screenshot → Verify page loaded

4. **TYPING PATTERN**
   - click: coordinate=[X,Y] → Focus input field
   - press_key: ["CTRL", "A"] → Select all
   - press_key: ["DELETE"] → Clear
   - type: "your text" → Type content
   - take_screenshot → Verify

5. **ONE ACTION PER RESPONSE**
   - Execute ONE computer tool call
   - Wait for result
   - Analyze
   - Next iteration: next action

**EXAMPLE: Search on DuckDuckGo**

Iteration 1: computer(action="take_screenshot") → See current state
Iteration 2: computer(action="press_key", keys=["CTRL", "L"]) → Focus address bar
Iteration 3: computer(action="type", text="https://duckduckgo.com") → Type URL
Iteration 4: computer(action="press_key", keys=["Return"]) → Navigate
Iteration 5: computer(action="take_screenshot") → Verify page loaded
Iteration 6: computer(action="click", coordinate=[640, 400]) → Click search box (from screenshot)
Iteration 7: computer(action="type", text="test query") → Type search
Iteration 8: computer(action="press_key", keys=["Return"]) → Submit
Iteration 9: computer(action="take_screenshot") → Verify results
Iteration 10: Return step_completed

**CRITICAL ANTI-PATTERNS:**
❌ Taking 5+ screenshots in a row without action
❌ Not taking action after seeing screenshot
❌ Multiple tool calls in one response
❌ Using old coordinates from previous screenshots
❌ Not verifying actions with screenshots
❌ Asking for user help when you can navigate/search/act yourself
❌ Using user_attention_required because page is not what you expected (NAVIGATE instead!)

═══════════════════════════════════════════════════════════════════

BEGIN STEP ${currentStep.order} EXECUTION NOW:`;

  return planPrompt;
}

/**
 * Format historical logs for context
 */
export function formatHistoricalLogs(historicalLogs: any[]): string {
  if (!historicalLogs || historicalLogs.length === 0) {
    return 'No previous logs available.';
  }

  return historicalLogs
    .map(log => {
      const shortMessage = log.message.length > 150 
        ? log.message.substring(0, 150) + '...' 
        : log.message;
      const timestamp = new Date(log.created_at).toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      const stepInfo = log.step_id ? ` [${log.step_id}]` : '';
      return `[${timestamp}]${stepInfo} ${log.log_type === 'agent_action' ? 'AGT' : 'USR'}: ${shortMessage}`;
    })
    .join('\n');
}

/**
 * Estimate token usage
 */
export function estimateTokens(systemPrompt: string, userPrompt: string): {
  systemTokens: number;
  promptTokens: number;
  totalTokens: number;
} {
  // Approximate: 1 token ≈ 4 chars for GPT models
  const estimatedSystemTokens = Math.ceil(systemPrompt.length / 4);
  const estimatedPromptTokens = Math.ceil(userPrompt.length / 4);
  const estimatedTotalTokens = estimatedSystemTokens + estimatedPromptTokens;
  
  console.log(`₍ᐢ•(ܫ)•ᐢ₎ Estimated tokens - System: ~${estimatedSystemTokens}, Prompt: ~${estimatedPromptTokens}, Total: ~${estimatedTotalTokens}`);
  
  if (estimatedTotalTokens > 100000) {
    console.warn(`⚠️ WARNING: Estimated tokens (${estimatedTotalTokens}) approaching Azure OpenAI limit (128k). Consider reducing context.`);
  } else {
    console.log(`✅ Token estimate within safe limits (${estimatedTotalTokens} / 128000)`);
  }
  
  return {
    systemTokens: estimatedSystemTokens,
    promptTokens: estimatedPromptTokens,
    totalTokens: estimatedTotalTokens
  };
}
