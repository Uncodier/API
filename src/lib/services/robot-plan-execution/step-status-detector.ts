/**
 * Step Status Detector Service
 * Handles detection of step completion status from agent responses
 */

import { extractStructuredResponse } from './response-parser';

/**
 * Detect step status from execution result
 */
export function detectStepStatus(
  executionResult: any,
  currentStepOrder: number,
  initialStatus: string
): { stepStatus: string; stepResult: string } {
  const { text, output } = executionResult as any;
  let stepStatus = initialStatus;
  let stepResult = '';

  console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🔍 Checking for structured output - stepStatus="${stepStatus}", output exists: ${!!output}`);
  if (output) {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🔍 Output details:`, { 
      event: output.event, 
      step: output.step, 
      message: output.assistant_message?.substring(0, 50) 
    });
  }
  
  if (stepStatus === 'in_progress') {
    // Prioritize structured output from Zod schema
    if (output && output.event && typeof output.step === 'number' && output.assistant_message) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STRUCTURED OUTPUT] ✅ Valid structured output found!`);
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STRUCTURED OUTPUT] Event: ${output.event}, Step: ${output.step}`);
      
      if (output.step === currentStepOrder) {
        stepResult = output.assistant_message;
        stepStatus = mapEventToStatus(output.event);
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STRUCTURED] Step ${output.step} ${output.event}: ${output.assistant_message}`);
      } else {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [STRUCTURED] Step number mismatch: expected ${currentStepOrder}, got ${output.step}`);
      }
    } 
    // Fallback to manual detection if no structured output
    else if (text) {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FALLBACK] No structured output, attempting manual extraction from text`);
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FALLBACK] Text length: ${text.length}`);
      
      const structuredResponse = extractStructuredResponse(text);
      
      if (structuredResponse && structuredResponse.step === currentStepOrder) {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FALLBACK] ✅ Manual extraction successful!`);
        stepResult = structuredResponse.assistant_message;
        stepStatus = mapEventToStatus(structuredResponse.event);
      } else {
        console.log(`₍ᐢ•(ܫ)•ᐢ₎ [FALLBACK] ❌ Manual extraction failed, trying regex patterns...`);
        
        const stepNumberPattern = new RegExp(`step\\s+${currentStepOrder}\\s+(finished|failed|canceled)`, 'i');
        const stepMatch = text.match(stepNumberPattern);
        
        if (stepMatch) {
          const detectedStatus = stepMatch[1].toLowerCase();
          stepResult = text;
          switch (detectedStatus) {
            case 'finished':
              stepStatus = 'completed';
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [REGEX] Step completion detected via regex fallback`);
              break;
            case 'failed':
              stepStatus = 'failed';
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [REGEX] Step failed detected via regex fallback`);
              break;
            case 'canceled':
              stepStatus = 'canceled';
              console.log(`₍ᐢ•(ܫ)•ᐢ₎ [REGEX] Step canceled detected via regex fallback`);
              break;
          }
        } else {
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [ERROR] ❌ NO RESPONSE DETECTED! Agent failed completely.`);
          console.log(`₍ᐢ•(ܫ)•ᐢ₎ [ENFORCEMENT] Marking as FAILED due to non-compliance`);
          stepStatus = 'failed';
          stepResult = `COMPLIANCE FAILURE: Agent did not provide any valid response format. Raw response: ${text?.substring(0, 500) || 'No text'}...`;
        }
      }
    } else {
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ [ERROR] ❌ NO OUTPUT OR TEXT! Complete agent failure.`);
      stepStatus = 'failed';
      stepResult = 'COMPLETE FAILURE: Agent provided no output or text response.';
    }
  }

  // Failsafe: If stepStatus still 'in_progress' but has output or text, try forcing detection
  if (stepStatus === 'in_progress' && (text || output)) {
    console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🚨 FAILSAFE: stepStatus is still in_progress, attempting to force completion detection`);
    
    // If structured output from final schema, use it
    if (output && output.event === 'step_completed') {
      stepStatus = 'completed';
      stepResult = output.assistant_message;
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🚨 FAILSAFE: Found step_completed in final output, forcing completion`);
    }
    // Otherwise but has text, assume completed (last resort)
    else if (text && text.length > 0) {
      stepStatus = 'completed';
      stepResult = text;
      console.log(`₍ᐢ•(ܫ)•ᐢ₎ 🚨 FAILSAFE: No clear completion signal, but execution finished with text - assuming completion`);
    }
  }

  return { stepStatus, stepResult };
}

/**
 * Map event type to internal status
 */
function mapEventToStatus(event: string): string {
  switch (event) {
    case 'step_completed':
      return 'completed';
    case 'step_failed':
      return 'failed';
    case 'step_canceled':
      return 'canceled';
    case 'plan_failed':
      return 'plan_failed';
    case 'plan_new_required':
      return 'new_plan_required';
    case 'session_acquired':
      return 'new_session';
    case 'session_needed':
      return 'session_needed';
    case 'session_saved':
      return 'completed';
    case 'user_attention_required':
      return 'user_attention_required';
    default:
      return 'in_progress';
  }
}
