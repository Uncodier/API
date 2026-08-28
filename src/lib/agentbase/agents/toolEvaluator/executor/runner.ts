/**
 * Módulo principal para la ejecución de herramientas
 * 
 * Este módulo proporciona la función principal que coordina
 * la ejecución de herramientas y la actualización de su estado.
 */
import { FunctionCall, ToolExecutionResult } from '../types';
import { executeTools } from './executeTools';
import { createToolsMap } from './toolsMap';
import { updateFunctionStatuses } from '../updater/functionStatusUpdater';
import { updateCommandStatus } from '../updater/commandStatusUpdater';
import { updateCommandContext } from '../updater/contextUpdater';
import { coerceToolArgs } from '@/lib/custom-automation/coerce-tool-args';
import { unknownToolError } from './dottedToolName';

/**
 * Main function to execute tools from the tool evaluator
 * @param functionCalls - Array of function calls to execute
 * @param tools - Array of available tools
 * @param commandId - Optional ID of the command that initiated these function calls
 * @param possibleMatchFunctions - Optional array of possible_match functions to include in the context
 * @returns Results of tool execution
 */
function rejectedAsResults(rejectedCalls: FunctionCall[] = []): ToolExecutionResult[] {
  return rejectedCalls.map((call) => ({
    id: call.id,
    function_name: call.name,
    arguments: call.arguments,
    status: 'error' as const,
    error: typeof call.error === 'string' ? call.error : unknownToolError(call.name),
    output: null,
  }));
}

export async function runToolExecution(
  functionCalls: FunctionCall[],
  tools: any[],
  commandId: string | null = null,
  possibleMatchFunctions?: FunctionCall[],
  context?: { site_id?: string; command_id?: string; rejectedCalls?: FunctionCall[] }
): Promise<ToolExecutionResult[]> {
  console.log(`[ToolExecutor] Starting tool execution for ${functionCalls.length} function calls`);
  
  // Extraer solo los nombres de herramientas necesarias para optimizar el mapeo
  const requiredToolNames = functionCalls
    .map(call => call.name || null)
    .filter((name): name is string => name !== null && name !== 'unknown_function');
  
  // Coerce tool arguments before execution to fix LLM serialization bugs (e.g. Gemini)
  if (functionCalls.length > 0 && tools && tools.length > 0) {
    for (const call of functionCalls) {
      if (!call.name) continue;
      const toolDef = tools.find(t => t.name === call.name);
      if (toolDef && toolDef.parameters && typeof call.arguments === 'string') {
        try {
          const parsedOuter = JSON.parse(call.arguments);
          const coerced = coerceToolArgs(toolDef.parameters, parsedOuter);
          const reserialized = JSON.stringify(coerced);
          if (reserialized !== call.arguments) {
            console.log(`[ToolExecutor] Coerced stringified nested arrays/objects for tool: ${call.name}`);
            call.arguments = reserialized;
          }
        } catch (e) {
          // Leave arguments intact if outer JSON fails to parse
        }
      }
    }
  }

  // Crear el mapa solo con las herramientas requeridas, no todas las disponibles
  const toolsMap = createToolsMap(tools, requiredToolNames);
  
  const executed = functionCalls.length > 0
    ? await executeTools(functionCalls, toolsMap, {
        ...context,
        command_id: commandId || context?.command_id,
      })
    : [];
  const results = [...executed, ...rejectedAsResults(context?.rejectedCalls)];
  
  console.log(`[ToolExecutor] Tool execution completed with ${results.length} results`);
  
  // Log possible_match functions if present
  if (possibleMatchFunctions && possibleMatchFunctions.length > 0) {
    console.log(`[ToolExecutor] Received ${possibleMatchFunctions.length} possible_match functions to include in context`);
  }
  
  // Actualizar el estado de las funciones en el comando
  if (commandId) {
    console.log(`[ToolExecutor] Updating function statuses for command: ${commandId}`);
    try {
      // Actualizar el estado de las funciones
      await updateFunctionStatuses(commandId, results);
      
      // Actualizar el contexto del comando con resultados de ejecución
      await updateCommandContext(commandId, results, functionCalls, possibleMatchFunctions);
      
      // Actualizar el estado del comando si es necesario
      await updateCommandStatus(commandId, results);
    } catch (error) {
      console.error(`[ToolExecutor] Error updating command data:`, error);
    }
  }
  
  return results;
}

export async function executeSelectedTools(
  functionCalls: FunctionCall[],
  tools: any[],
  commandId: string,
  possibleMatchFunctions?: FunctionCall[],
  site_id?: string,
  rejectedFunctionCalls?: FunctionCall[]
): Promise<ToolExecutionResult[]> {
  console.log(`[ToolEvaluator] Starting execution of ${functionCalls.length} selected tools for command: ${commandId}`);

  try {
    const executableCalls = functionCalls.filter((call) => call.status !== 'possible_match');
    const rejectedCalls = rejectedFunctionCalls || [];

    if (executableCalls.length < functionCalls.length) {
      console.log(`[ToolEvaluator] Skipping ${functionCalls.length - executableCalls.length} possible_match functions`);
    }

    if (executableCalls.length === 0 && rejectedCalls.length === 0) {
      console.log(`[ToolEvaluator] No executable functions remain after filtering possible_match status`);

      if (possibleMatchFunctions && possibleMatchFunctions.length > 0) {
        console.log(`[ToolEvaluator] Still adding ${possibleMatchFunctions.length} possible_match functions to context`);
        await runToolExecution([], tools, commandId, possibleMatchFunctions, { site_id });
      }

      return [];
    }

    const results = await runToolExecution(executableCalls, tools, commandId, possibleMatchFunctions, {
      site_id,
      rejectedCalls,
    });
    console.log(`[ToolEvaluator] Tool execution completed with ${results.length} results`);
    return results;
  } catch (error: any) {
    console.error(`[ToolEvaluator] Error executing tools (non-fatal):`, error);
    return [{
      id: 'tool_execution_error',
      function_name: 'tool_execution',
      status: 'error',
      error: error.message || 'Unknown tool execution error',
      output: null,
      arguments: '{}',
    }];
  }
} 