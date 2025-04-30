/**
 * Módulo principal para la ejecución de herramientas
 * 
 * Este módulo proporciona la función principal que coordina
 * la ejecución de herramientas y la actualización de su estado.
 */
import { FunctionCall, ToolExecutionResult } from '../types';
import { executeTools } from './executeTools';
import { createToolsMap } from './toolsMap';

// Importaciones mediante import dinámico para evitar ciclos de dependencia
async function getUpdaters() {
  return await import('../updater');
}

/**
 * Main function to execute tools from the tool evaluator
 * @param functionCalls - Array of function calls to execute
 * @param tools - Array of available tools
 * @param commandId - Optional ID of the command that initiated these function calls
 * @returns Results of tool execution
 */
export async function runToolExecution(
  functionCalls: FunctionCall[],
  tools: any[],
  commandId: string | null = null
): Promise<ToolExecutionResult[]> {
  console.log(`[ToolExecutor] Starting tool execution for ${functionCalls.length} function calls`);
  
  // Create a map of tool names to their implementation functions
  const toolsMap = createToolsMap(tools);
  
  // Execute the tools
  const results = await executeTools(functionCalls, toolsMap);
  
  console.log(`[ToolExecutor] Tool execution completed with ${results.length} results`);
  
  if (commandId) {
    // Importar los módulos updater dinámicamente
    const updaters = await getUpdaters();
    
    console.log(`[ToolExecutor] 🔎 DEBUG - Function calls antes de ejecución: ${JSON.stringify(functionCalls.map(fc => ({
      id: fc.id,
      name: fc.name,
      status: fc.status
    })))}`);
    
    console.log(`[ToolExecutor] 🔎 DEBUG - Results después de ejecución: ${JSON.stringify(results.map(r => ({
      id: r.id,
      status: r.status,
      function_name: r.function_name,
      error: r.error ? (r.error.length > 100 ? r.error.substring(0, 100) + '...' : r.error) : null
    })))}`);
    
    // Obtener estado inicial del comando para comparación
    try {
      const { CommandCache } = await import('../../../services/command/CommandCache');
      const initialCommand = CommandCache.getCachedCommand(commandId);
      if (initialCommand && initialCommand.functions && initialCommand.functions.length > 0) {
        console.log(`[ToolExecutor] 🔎 DEBUG - Estado INICIAL de funciones: ${JSON.stringify(initialCommand.functions.map(f => ({
          id: f.id,
          name: f.name,
          status: f.status
        })))}`);
      }
    } catch (error) {
      console.warn(`[ToolExecutor] No se pudo obtener estado inicial de funciones: ${error}`);
    }
    
    // Update function statuses to completed if no errors
    console.log(`[ToolExecutor] 📝 Llamando a updateFunctionStatuses para comandoId: ${commandId}`);
    const allFunctionsSuccessful = await updaters.updateFunctionStatuses(commandId, results);
    console.log(`[ToolExecutor] ✅ updateFunctionStatuses completado, resultado: ${allFunctionsSuccessful}`);
    
    // Update the overall command status
    console.log(`[ToolExecutor] 📝 Llamando a updateCommandStatus para comandoId: ${commandId}`);
    await updaters.updateCommandStatus(commandId, results);
    console.log(`[ToolExecutor] ✅ updateCommandStatus completado`);
    
    // Update command context with tool execution results
    console.log(`[ToolExecutor] 📝 Llamando a updateCommandContext para comandoId: ${commandId}`);
    await updaters.updateCommandContext(commandId, results, functionCalls);
    console.log(`[ToolExecutor] ✅ updateCommandContext completado`);
    
    // Log del estado actual de las funciones para verificación
    try {
      const { CommandCache } = await import('../../../services/command/CommandCache');
      const cachedCommand = CommandCache.getCachedCommand(commandId);
      if (cachedCommand && cachedCommand.functions && cachedCommand.functions.length > 0) {
        const failedFunctions = cachedCommand.functions.filter(f => f.status === 'failed').length;
        const completedFunctions = cachedCommand.functions.filter(f => f.status === 'completed').length;
        console.log(`[ToolExecutor] Estado de funciones después de ejecutar: ${completedFunctions} completed, ${failedFunctions} failed de ${cachedCommand.functions.length} totales`);
      }
    } catch (error) {
      console.warn(`[ToolExecutor] No se pudo verificar el estado de las funciones en caché: ${error}`);
    }
  } else {
    console.log(`[ToolExecutor] No command ID provided, skipping status and context updates`);
  }
  
  return results;
} 