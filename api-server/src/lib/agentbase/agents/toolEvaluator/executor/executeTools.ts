/**
 * Módulo para la ejecución de herramientas seleccionadas
 * 
 * Este módulo proporciona la funcionalidad para ejecutar las herramientas
 * que han sido seleccionadas por el ToolEvaluator.
 */
import { FunctionCall, ToolExecutionResult } from '../types';

/**
 * Execute the selected tools from the tool evaluator response
 * @param functionCalls - Array of function calls to execute
 * @param toolsMap - Map of tool names to their implementation functions
 * @returns Results of tool execution
 */
export async function executeTools(
  functionCalls: FunctionCall[],
  toolsMap: Record<string, any>
): Promise<ToolExecutionResult[]> {
  console.log(`[ToolExecutor] Executing ${functionCalls.length} tools`);
  
  const results: ToolExecutionResult[] = [];
  
  // Validar disponibilidad de herramientas antes de comenzar
  const availableTools = Object.keys(toolsMap);
  console.log(`[ToolExecutor] Available tools in map: ${availableTools.join(', ')}`);
  
  for (const call of functionCalls) {
    try {
      // Obtener el nombre y argumentos de la función (ahora en la raíz)
      const functionName = call.name || call.function?.name || 'unknown_function';
      const functionArgs = call.arguments || (call.function?.arguments || '{}');
      
      console.log(`[ToolExecutor] Processing function call: ${functionName}`);
      
      // Preservar el ID original para correlacionar resultados
      const callId = call.id || `call_${Math.random().toString(36).substring(2, 8)}`;
      
      // Validar que el nombre de la función sea válido
      if (!functionName || functionName === 'unknown_function') {
        console.error(`[ToolExecutor] Invalid or missing function name in call ID: ${callId}`);
        results.push({
          id: callId,
          status: 'error',
          error: `Invalid or missing function name`,
          output: null,
          function_name: functionName, // Nombre real o indicador de falta
          arguments: functionArgs // Preservar argumentos originales
        });
        continue;
      }
      
      // Get the tool implementation
      const toolFunction = toolsMap[functionName];
      
      if (!toolFunction) {
        console.error(`[ToolExecutor] Tool function not found: ${functionName}. Available tools: ${availableTools.join(', ')}`);
        const errorInfo = {
          reason: 'TOOL_NOT_FOUND',
          message: `Tool function not found: ${functionName}. No implementation available for this tool.`,
          available_tools: availableTools.length > 0 ? availableTools : ['none']
        };
        
        results.push({
          id: callId,
          status: 'error',
          error: JSON.stringify(errorInfo),
          output: null,
          function_name: functionName, // Preservar nombre original de la función
          arguments: functionArgs // Preservar argumentos originales
        });
        
        // Log adicional para seguimiento
        console.error(`[ToolExecutor] CRITICAL: Marked function ${functionName} with status 'error' - needs to be updated to 'failed'`);
        continue;
      }
      
      // Parse arguments if they are in string format
      let parsedArgs = {};
      try {
        if (typeof functionArgs === 'string') {
          parsedArgs = JSON.parse(functionArgs);
        } else if (typeof functionArgs === 'object') {
          parsedArgs = functionArgs;
        }
      } catch (error: any) {
        console.error(`[ToolExecutor] Error parsing arguments for ${functionName}:`, error);
        results.push({
          id: callId,
          status: 'error',
          error: `Error parsing arguments: ${error.message}`,
          output: null,
          function_name: functionName, // Preservar nombre original de la función
          arguments: functionArgs // Preservar argumentos originales
        });
        continue;
      }
      
      // Log the function that will be executed with its arguments
      console.log(`[ToolExecutor] Executing tool: ${functionName} with args:`, parsedArgs);
      
      try {
        // Intentar ejecutar la herramienta real con los argumentos parseados
        const output = await toolFunction(parsedArgs);
        
        // Registrar resultado exitoso
        results.push({
          id: callId,
          function_name: functionName,
          arguments: functionArgs,
          status: 'success',
          error: null,
          output: output || `Executed ${functionName} successfully`
        });
      } catch (execError: any) {
        // Capturar errores de ejecución específicos
        console.error(`[ToolExecutor] Error executing tool ${functionName}:`, execError);
        results.push({
          id: callId,
          function_name: functionName,
          arguments: functionArgs,
          status: 'error',
          error: execError.message || `Error executing ${functionName}`,
          output: null
        });
      }
      
    } catch (error: any) {
      console.error(`[ToolExecutor] Error executing tool:`, error);
      
      // Recuperar o generar un ID para correlacionar resultados
      const callId = call.id || `call_${Math.random().toString(36).substring(2, 8)}`;
      
      // Usar información de la raíz si está disponible, con fallbacks
      const functionName = call.name || (call.function?.name || 'unknown_function');
      const functionArgs = call.arguments || (call.function?.arguments || '{}');
      
      results.push({
        id: callId,
        status: 'error',
        error: error.message || 'Unknown error during execution',
        output: null,
        function_name: functionName,
        arguments: functionArgs
      });
    }
  }
  
  console.log(`[ToolExecutor] Completed execution of ${functionCalls.length} tools`);
  
  // Mostrar resumen detallado para cada resultado
  console.log(`[ToolExecutor] 📊 Resumen de resultados de ejecución:`);
  for (const result of results) {
    const statusEmoji = result.status === 'success' ? '✅' : '❌';
    console.log(`[ToolExecutor] ${statusEmoji} Función: ${result.function_name} (ID: ${result.id})`);
    console.log(`[ToolExecutor]    Status: ${result.status}`);
    if (result.error) {
      // Extraer solo la parte importante del mensaje de error
      let errorMsg = result.error;
      try {
        // Si es un JSON, intentar extraer el mensaje
        const errorObj = JSON.parse(result.error);
        errorMsg = errorObj.message || errorObj.reason || result.error;
      } catch (e) {
        // No es JSON, usar como está
      }
      console.log(`[ToolExecutor]    Error: ${errorMsg.length > 100 ? errorMsg.substring(0, 100) + '...' : errorMsg}`);
    }
    if (result.output) {
      const outputStr = typeof result.output === 'string' 
        ? result.output 
        : JSON.stringify(result.output);
      console.log(`[ToolExecutor]    Output: ${outputStr.length > 50 ? outputStr.substring(0, 50) + '...' : outputStr}`);
    }
  }
  
  return results;
} 