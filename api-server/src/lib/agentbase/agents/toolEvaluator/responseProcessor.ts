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
        console.log(`[ToolEvaluator] Processing item type: ${item.type}`);
        if (item.type === 'exclusion') {
          // Handle exclusions - already in the correct format
          console.log(`[ToolEvaluator] Added exclusion for tool: ${item.name}`);
          toolDecisions.push(item as ToolExclusion);
        } 
        else if (item.type === 'function') {
          // Handle function calls - already in the correct format
          console.log(`[ToolEvaluator] Added function call for: ${item.function?.name}`);
          toolDecisions.push(item as FunctionCall);
        } 
        else if (item.type === 'function_call') {
          // Convert old format to new format
          console.log(`[ToolEvaluator] Converting old format function_call to new format for: ${item.name}`);
          const functionCall: FunctionCall = {
            id: `call_${uuidv4().split('-')[0]}`,
            type: "function",
            status: "initialized",
            function: {
              name: item.name,
              arguments: item.arguments
            }
          };
          toolDecisions.push(functionCall);
        } else {
          console.log(`[ToolEvaluator] Unknown item type: ${item.type}, skipping`);
        }
      }
    } else {
      console.warn('[ToolEvaluator] Unexpected response format:', response);
      
      // If response is a single object with type, wrap it in an array and process
      if (response && typeof response === 'object' && response.type) {
        console.log(`[ToolEvaluator] Response is a single object with type: ${response.type}, converting to array`);
        // Create a new array containing the single object and process it recursively
        const wrappedResponse = [response];
        
        console.log(`[ToolEvaluator] Wrapped single object response in array, processing again`);
        // Process the wrapped response recursively
        return processToolEvaluationResponse(wrappedResponse, tools);
      }
      
      // If response is a single object with function property, convert to function call
      else if (response && typeof response === 'object' && response.function) {
        console.log(`[ToolEvaluator] Found single function object, converting to function call`);
        const functionCall: FunctionCall = {
          id: `call_${uuidv4().split('-')[0]}`,
          type: "function",
          status: "initialized",
          function: {
            name: response.function.name || response.name,
            arguments: response.function.arguments || response.arguments || '{}'
          }
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
            if (call.function) {
              console.log(`[ToolEvaluator] Converting tool_call for: ${call.function.name}`);
              const functionCall: FunctionCall = {
                id: `call_${uuidv4().split('-')[0]}`,
                type: "function",
                status: "initialized",
                function: {
                  name: call.function.name,
                  arguments: call.function.arguments || '{}'
                }
              };
              toolDecisions.push(functionCall);
            }
          }
        } 
        // Process single function_call (OpenAI's older format)
        else if (response.function_call) {
          console.log(`[ToolEvaluator] Converting function_call for: ${response.function_call.name}`);
          const functionCall: FunctionCall = {
            id: `call_${uuidv4().split('-')[0]}`,
            type: "function",
            status: "initialized",
            function: {
              name: response.function_call.name,
              arguments: response.function_call.arguments || '{}'
            }
          };
          toolDecisions.push(functionCall);
        }
      }
      
      // If response is in old format with tool_decisions, convert to new format
      else if (response && response.tool_decisions && Array.isArray(response.tool_decisions)) {
        console.log(`[ToolEvaluator] Found legacy tool_decisions array with ${response.tool_decisions.length} items`);
        for (const decision of response.tool_decisions) {
          if (decision.should_use) {
            console.log(`[ToolEvaluator] Converting legacy 'should_use' decision for tool: ${decision.tool_name}`);
            const functionCall: FunctionCall = {
              id: `call_${uuidv4().split('-')[0]}`,
              type: "function",
              status: "initialized",
              function: {
                name: decision.tool_name,
                arguments: JSON.stringify(decision.parameters || {})
              }
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
                function: {
                  name: toolName,
                  arguments: argsString
                }
              };
              
              toolDecisions.push(functionCall);
              break; // Only create one function call from this fallback
            }
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
        return decision.function.name;
      } else {
        return decision.name;
      }
    })
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