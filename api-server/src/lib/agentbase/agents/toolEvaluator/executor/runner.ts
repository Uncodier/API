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

/**
 * Main function to execute tools from the tool evaluator
 * @param functionCalls - Array of function calls to execute
 * @param tools - Array of available tools
 * @param commandId - Optional ID of the command that initiated these function calls
 * @param possibleMatchFunctions - Optional array of possible_match functions to include in the context
 * @returns Results of tool execution
 */
export async function runToolExecution(
  functionCalls: FunctionCall[],
  tools: any[],
  commandId: string | null = null,
  possibleMatchFunctions?: FunctionCall[]
): Promise<ToolExecutionResult[]> {
  console.log(`[ToolExecutor] Starting tool execution for ${functionCalls.length} function calls`);
  
  // Extraer solo los nombres de herramientas necesarias para optimizar el mapeo
  const requiredToolNames = functionCalls
    .map(call => call.name || null)
    .filter((name): name is string => name !== null && name !== 'unknown_function');
  
  // Crear el mapa solo con las herramientas requeridas, no todas las disponibles
  const toolsMap = createToolsMap(tools, requiredToolNames);
  
  // Execute the tools
  const results = await executeTools(functionCalls, toolsMap);
  
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