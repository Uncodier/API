/**
 * Response processing utilities for ToolEvaluator
 */
import { v4 as uuidv4 } from 'uuid';
import { ToolDecision, ToolExclusion, FunctionCall } from './types';

/**
 * Process tool evaluation response from LLM
 */
export function processToolEvaluationResponse(response: any, tools: any[]): ToolDecision[] {
  let toolDecisions: ToolDecision[] = [];

  try {
    console.log(`[ToolEvaluator] Processing response: ${typeof response}`);
    
    // Try to parse response as JSON
    if (typeof response === 'string') {
      console.log(`[ToolEvaluator] Response is string, attempting to parse as JSON`);
      try {
        response = JSON.parse(response);
        console.log(`[ToolEvaluator] Successfully parsed string response as JSON`);
      } catch (e) {
        console.log(`[ToolEvaluator] Failed to parse as regular JSON, trying to extract JSON blocks`);
        // If not valid JSON, try to extract JSON blocks
        const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/) || 
                         response.match(/\[[\s\S]*\]/) || 
                         response.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
          console.log(`[ToolEvaluator] Found JSON block, attempting to parse: ${jsonMatch[1] || jsonMatch[0]}`);
          try {
            response = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            console.log(`[ToolEvaluator] Successfully parsed JSON block`);
          } catch (e) {
            console.log(`[ToolEvaluator] Failed to parse JSON block: ${e}`);
          }
        } else {
          console.log(`[ToolEvaluator] No valid JSON block found in response`);
        }
      }
    }

    // Check for response objects that might have a decisions or functions array embedded
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      console.log(`[ToolEvaluator] Checking for embedded arrays in object response`);
      
      // Check common property names that might contain the actual tool decisions
      const possibleArrayProperties = ['decisions', 'tools', 'tool_decisions', 'functions', 'function_calls', 'items'];
      
      for (const prop of possibleArrayProperties) {
        if (response[prop] && Array.isArray(response[prop])) {
          console.log(`[ToolEvaluator] Found embedded array in property '${prop}' with ${response[prop].length} items`);
          response = response[prop];
          break;
        }
      }
    }

    // Validate that response is an array
    if (response && Array.isArray(response)) {
      console.log(`[ToolEvaluator] Response is array with ${response.length} items`);
      for (const item of response) {
        if (!item) {
          console.log(`[ToolEvaluator] Skipping null or undefined item in response array`);
          continue;
        }
        
        console.log(`[ToolEvaluator] Processing item type: ${item.type}`);
        if (item.type === 'exclusion') {
          // Handle exclusions - already in the correct format
          if (item.name) {
            console.log(`[ToolEvaluator] Added exclusion for tool: ${item.name}`);
            toolDecisions.push(item as ToolExclusion);
          } else {
            console.log(`[ToolEvaluator] Skipping exclusion with missing name property`);
          }
        } 
        else if (item.type === 'function') {
          // Handle function calls - use flat format
          if (item.name) {
            console.log(`[ToolEvaluator] Added function call for: ${item.name}`);
            const functionCall: FunctionCall = {
              id: item.id || `call_${uuidv4().split('-')[0]}`,
              type: "function",
              status: item.status || "initialized",
              name: item.name,
              arguments: item.arguments || "{}",
            };
            
            // Add required_arguments if present and status is possible_match
            if (item.status === "possible_match" && Array.isArray(item.required_arguments)) {
              console.log(`[ToolEvaluator] Function ${item.name} has possible_match status with ${item.required_arguments.length} required arguments`);
              functionCall.required_arguments = item.required_arguments;
            }
            
            toolDecisions.push(functionCall);
          } else {
            console.log(`[ToolEvaluator] Skipping function call with missing name property`);
          }
        } else {
          console.log(`[ToolEvaluator] Unknown decision type: ${item.type}`);
        }
      }
    } 
    // Handle nested function objects
    else if (response && typeof response === 'object' && response.function) {
      console.log(`[ToolEvaluator] Found single function object, converting to function call`);
      const functionName = response.function.name || response.name || "unknown_function";
      const functionCall: FunctionCall = {
        id: `call_${uuidv4().split('-')[0]}`,
        type: "function",
        status: "initialized",
        name: functionName,
        arguments: response.function.arguments || response.arguments || '{}'
      };
      toolDecisions.push(functionCall);
    }
    
    // Handle OpenAI-style function calls
    else if (response && typeof response === 'object' && 
            (response.function_call || response.tool_calls)) {
      console.log(`[ToolEvaluator] Found OpenAI-style function call format`);
      
      // Process tool_calls (OpenAI's new format)
      if (response.tool_calls && Array.isArray(response.tool_calls)) {
        console.log(`[ToolEvaluator] Processing tool_calls array with ${response.tool_calls.length} items`);
        for (const call of response.tool_calls) {
          if (call && call.function && call.function.name) {
            console.log(`[ToolEvaluator] Converting tool_call for: ${call.function.name}`);
            const functionCall: FunctionCall = {
              id: `call_${uuidv4().split('-')[0]}`,
              type: "function",
              status: "initialized",
              name: call.function.name,
              arguments: call.function.arguments || '{}'
            };
            toolDecisions.push(functionCall);
          } else {
            console.log(`[ToolEvaluator] Skipping invalid tool_call without function name`);
          }
        }
      } 
      // Process single function_call (OpenAI's older format)
      else if (response.function_call && response.function_call.name) {
        console.log(`[ToolEvaluator] Converting function_call for: ${response.function_call.name}`);
        const functionCall: FunctionCall = {
          id: `call_${uuidv4().split('-')[0]}`,
          type: "function",
          status: "initialized",
          name: response.function_call.name,
          arguments: response.function_call.arguments || '{}'
        };
        toolDecisions.push(functionCall);
      } else {
        console.log(`[ToolEvaluator] Invalid OpenAI-style function call format, missing required properties`);
      }
    }
    
    // If response is in old format with tool_decisions, convert to new format
    else if (response && response.tool_decisions && Array.isArray(response.tool_decisions)) {
      console.log(`[ToolEvaluator] Found legacy tool_decisions array with ${response.tool_decisions.length} items`);
      for (const decision of response.tool_decisions) {
        if (decision && decision.tool_name) {
          if (decision.should_use) {
            console.log(`[ToolEvaluator] Converting legacy 'should_use' decision for tool: ${decision.tool_name}`);
            const functionCall: FunctionCall = {
              id: `call_${uuidv4().split('-')[0]}`,
              type: "function",
              status: "initialized",
              name: decision.tool_name,
              arguments: JSON.stringify(decision.parameters || {})
            };
            toolDecisions.push(functionCall);
          } else {
            console.log(`[ToolEvaluator] Converting legacy exclusion for tool: ${decision.tool_name}`);
            const exclusion: ToolExclusion = {
              reasoning: decision.reasoning || "Tool should not be used based on user request",
              type: "exclusion",
              name: decision.tool_name
            };
            toolDecisions.push(exclusion);
          }
        } else {
          console.log(`[ToolEvaluator] Skipping invalid legacy tool decision without tool_name`);
        }
      }
    } else {
      console.log(`[ToolEvaluator] Unexpected response format, no recognizable structure found`);
      
      // Last resort fallback - try to salvage any usable information from the response
      console.log(`[ToolEvaluator] Attempting fallback parsing of unexpected response format`);
      
      // If we can identify any tool names in the response, create default function calls
      if (typeof response === 'object' && response !== null) {
        // Look for any property that might contain a tool name
        for (const tool of tools) {
          const toolName = tool.name;
          
          // Check if the tool name appears as a key or value in the response
          const hasToolReference = 
            Object.keys(response).includes(toolName) || 
            JSON.stringify(response).includes(`"${toolName}"`) ||
            // Look for any property named 'name' with the tool name as value
            (response.name === toolName);
            
          if (hasToolReference) {
            console.log(`[ToolEvaluator] Found reference to tool '${toolName}' in response, creating function call`);
            
            // Extract arguments if they exist in the response
            let argsString = '{}';
            if (response[toolName] && typeof response[toolName] === 'object') {
              argsString = JSON.stringify(response[toolName]);
            } else if (response.arguments) {
              argsString = typeof response.arguments === 'string' 
                ? response.arguments 
                : JSON.stringify(response.arguments);
            }
            
            const functionCall: FunctionCall = {
              id: `call_${uuidv4().split('-')[0]}`,
              type: "function",
              status: "initialized",
              name: toolName,
              arguments: argsString
            };
            
            toolDecisions.push(functionCall);
            break; // Only create one function call from this fallback
          }
        }
      }
    }
  } catch (error) {
    console.error(`[ToolEvaluator] Error processing evaluation response: ${error}`);
    toolDecisions = [];
  }

  // Verify that all tools are covered in decisions
  const toolNames = tools.map(tool => tool.name);
  const coveredTools = new Set(
    toolDecisions.map(decision => {
      if (decision.type === 'function') {
        return decision.name;
      } else if (decision.type === 'exclusion' && decision.name) {
        return decision.name;
      }
      return null;
    }).filter(name => name !== null)
  );
  
  // Add missing tools as "exclusion" decisions
  const missingTools = toolNames.filter(name => !coveredTools.has(name));
  
  if (missingTools.length > 0) {
    console.log(`[ToolEvaluator] Adding default exclusions for ${missingTools.length} tools not covered in decisions`);
    
    for (const toolName of missingTools) {
      console.log(`[ToolEvaluator] Adding default exclusion for: ${toolName}`);
      toolDecisions.push({
        reasoning: "Tool was not selected for evaluation",
        type: "exclusion",
        name: toolName
      });
    }
  }

  console.log(`[ToolEvaluator] Final tool decisions count: ${toolDecisions.length}`);
  return toolDecisions;
}

/**
 * Generate function calls in the new format
 */
export function generateFunctions(decisions: ToolDecision[]): FunctionCall[] {
  // Filter out only the FunctionCall objects
  const functionCalls: FunctionCall[] = decisions
    .filter(decision => decision.type === 'function')
    .map(decision => decision as FunctionCall);
  
  return functionCalls;
}

/**
 * Process tool evaluation response from LLM and prepare function calls for execution
 * 
 * This is a combined function that processes the response and generates function calls in one step
 * @param response - The raw LLM response
 * @param tools - Available tools
 * @returns Array of function calls ready for execution
 */
export function prepareToolsForExecution(response: any, tools: any[]): FunctionCall[] {
  console.log(`[ToolEvaluator] Preparing tools for execution`);
  
  // First process the evaluation response
  const decisions = processToolEvaluationResponse(response, tools);
  
  // Then extract function calls
  const functionCalls = generateFunctions(decisions);
  
  // Create a set of valid tool names for efficient lookup
  const validToolNames = new Set(tools.map(tool => typeof tool === 'string' ? tool : tool.name));
  console.log(`[ToolEvaluator] Valid tool names: ${Array.from(validToolNames).join(', ')}`);
  
  // Filter function calls to only include those with valid tool names and status 'required'
  const validatedFunctionCalls = functionCalls.filter(call => {
    // Obtener el nombre de la función 
    const functionName = call.name;
    
    if (!functionName || functionName === 'unknown_function') {
      console.warn(`[ToolEvaluator] Skipping function call with missing or unknown name`);
      return false;
    }
    
    if (!validToolNames.has(functionName)) {
      console.warn(`[ToolEvaluator] Skipping function call with invalid tool name: ${functionName}`);
      return false;
    }
    
    // Skip function calls with status 'possible_match' - they need more info from the user
    if (call.status === 'possible_match') {
      console.log(`[ToolEvaluator] Skipping 'possible_match' function: ${functionName} - missing required arguments: ${call.required_arguments?.join(', ')}`);
      return false;
    }
    
    // Ensure all remaining functions have status 'required'
    if (call.status !== 'required') {
      console.log(`[ToolEvaluator] Setting function ${functionName} status to 'required' (was: ${call.status || 'undefined'})`);
      call.status = 'required';
    }
    
    return true;
  });
  
  if (validatedFunctionCalls.length < functionCalls.length) {
    console.warn(`[ToolEvaluator] Filtered out ${functionCalls.length - validatedFunctionCalls.length} invalid function calls`);
  }
  
  console.log(`[ToolEvaluator] Prepared ${validatedFunctionCalls.length} tools for execution`);
  return validatedFunctionCalls;
} 