/**
 * Módulo para actualizar el contexto del comando
 * 
 * Este módulo proporciona funcionalidad para actualizar el contexto
 * del comando con los resultados de la ejecución de herramientas.
 */
import { FunctionCall, ToolExecutionResult } from '../types';
import { CommandService } from '../../../services/command';

/**
 * Update command context with tool execution results
 * @param commandId - ID of the command to update
 * @param functionResults - Results of function executions
 * @param functionCalls - Original function calls with tool names and arguments
 * @param possibleMatchFunctions - Optional array of functions with possible_match status
 */
export async function updateCommandContext(
  commandId: string | null,
  functionResults: ToolExecutionResult[],
  functionCalls: FunctionCall[],
  possibleMatchFunctions?: FunctionCall[]
): Promise<void> {
  if (!commandId) {
    console.log('[ToolExecutor] No command ID provided, skipping context update');
    return;
  }

  console.log(`[ToolExecutor] Updating command context with tool results for command: ${commandId}`);
  
  try {
    // Instanciar el servicio de comandos
    const commandService = new CommandService();
    
    // Obtener el comando actual para preservar el contexto existente
    const currentCommand = await commandService.getCommandById(commandId);
    if (!currentCommand) {
      console.error(`[ToolExecutor] Could not find command with ID: ${commandId}`);
      return;
    }
    
    // Crear un mapa de resultados para acceso rápido por ID
    const resultMap = new Map<string, ToolExecutionResult>();
    for (const result of functionResults) {
      resultMap.set(result.id, result);
    }
    
    // Actualizar el estado de las funciones en el comando
    const updatedFunctions = currentCommand.functions ? [...currentCommand.functions] : [];
    let functionsModified = false;
    
    // Crear una representación de texto formateada para el contexto
    const contextParts: string[] = [];
    
    // Procesar cada resultado de ejecución
    for (const result of functionResults) {
      // Buscar la función correspondiente en el array del comando
      const functionIndex = updatedFunctions.findIndex(func => func.id === result.id);
      
      if (functionIndex >= 0) {
        // Actualizar estado y resultados de la función existente
        updatedFunctions[functionIndex] = {
          ...updatedFunctions[functionIndex],
          status: result.status === 'success' ? 'completed' : 'failed',
          result: result.output || null,
          error: result.error || null
        };
        functionsModified = true;
        
        // Crear entrada de texto para esta función
        const toolName = updatedFunctions[functionIndex].name || '[FUNCTION NAME MISSING]';
        const toolArgs = updatedFunctions[functionIndex].arguments || '{}';
        const status = result.status === 'success' ? 'succeeded' : 'failed';
        
        // Generar salida más detallada para errores
        let output = 'No output';
        let errorInfo = '';
        
        if (result.status === 'success') {
          // Para resultados exitosos, mostrar la salida directamente
          output = result.output ? 
            (typeof result.output === 'string' ? result.output : JSON.stringify(result.output)) : 
            'No output';
        } else {
          // Para errores, utilizar el campo de error en lugar de output
          output = 'Failed to execute function';
          errorInfo = result.error ? 
            `\nError: ${result.error}` : 
            '\nError: Unknown execution error';
        }
        
        contextParts.push(`Tool: ${toolName}\nArguments: ${toolArgs}\nStatus: ${status}\nOutput: ${output}${errorInfo}`);
      } else {
        // Si no se encuentra la función en el array, usar datos del resultado directamente
        console.log(`[ToolExecutor] Function with ID ${result.id} not found in command.functions`);
        
        // Intentar obtener nombre de la función desde el resultado o el ID
        let toolName = result.function_name || '[FUNCTION NAME MISSING]';
        if (!toolName && result.id) {
          const namePart = result.id.split('_').pop();
          if (namePart && namePart.length > 1) {
            toolName = namePart;
          }
        }
        
        // Crear entrada de texto para esta función no encontrada
        const toolArgs = result.arguments ? 
          (typeof result.arguments === 'string' ? result.arguments : JSON.stringify(result.arguments)) : 
          '{}';
        const status = result.status === 'success' ? 'succeeded' : 'failed';
        
        // Generar salida más detallada para errores
        let output = 'No output';
        let errorInfo = '';
        
        if (result.status === 'success') {
          // Para resultados exitosos, mostrar la salida directamente
          output = result.output ? 
            (typeof result.output === 'string' ? result.output : JSON.stringify(result.output)) : 
            'No output';
        } else {
          // Para errores, utilizar el campo de error en lugar de output
          output = 'Failed to execute function';
          errorInfo = result.error ? 
            `\nError: ${result.error}` : 
            '\nError: Unknown execution error';
        }
        
        contextParts.push(`Tool: ${toolName}\nArguments: ${toolArgs}\nStatus: ${status}\nOutput: ${output}${errorInfo}`);
      }
    }
    
    // Procesar funciones con possible_match para agregar al contexto
    if (possibleMatchFunctions && possibleMatchFunctions.length > 0) {
      // Crear una sección específica para las posibles coincidencias
      const possibleMatchParts: string[] = [];
      
      console.log(`[ToolExecutor] Adding ${possibleMatchFunctions.length} possible match functions to context`);
      
      for (const matchFunc of possibleMatchFunctions) {
        // Obtener el nombre de la herramienta y sus argumentos
        const toolName = matchFunc.name || '[FUNCTION NAME MISSING]';
        const toolArgs = matchFunc.arguments ? 
          (typeof matchFunc.arguments === 'string' ? matchFunc.arguments : JSON.stringify(matchFunc.arguments)) : 
          '{}';
        
        // Obtener los argumentos requeridos faltantes
        const missingArgs = matchFunc.required_arguments && matchFunc.required_arguments.length > 0 
          ? matchFunc.required_arguments.join(', ') 
          : 'unknown required arguments';
        
        // Formatear la información para incluirla en el contexto
        possibleMatchParts.push(
          `Tool: ${toolName}\nStatus: possible_match\nArguments Provided: ${toolArgs}\nMissing Required Arguments: ${missingArgs}`
        );
        
        // También agregar la función al array de funciones si no existe ya
        const existingFuncIndex = updatedFunctions.findIndex(func => 
          func.id === matchFunc.id || (func.name === matchFunc.name && func.status === 'possible_match')
        );
        
        if (existingFuncIndex === -1) {
          console.log(`[ToolExecutor] Adding possible_match function to functions array: ${toolName}`);
          updatedFunctions.push(matchFunc);
          functionsModified = true;
        }
      }
      
      // Agregar la sección de posibles coincidencias al contexto
      if (possibleMatchParts.length > 0) {
        const possibleMatchAdditions = possibleMatchParts.join('\n\n');
        contextParts.push(`--- Possible Tool Matches (Missing Required Arguments) ---\n${possibleMatchAdditions}`);
      }
    }
    
    // Si hay actualizaciones para agregar al contexto
    if (contextParts.length > 0) {
      // Unir todas las partes con doble salto de línea
      const contextAdditions = contextParts.join('\n\n');
      
      // Preparar el nuevo contexto añadiéndolo al existente
      const existingContext = currentCommand.context || '';
      const newContext = existingContext 
        ? `${existingContext}\n\n--- Tool Results and Information ---\n${contextAdditions}`
        : `--- Tool Results and Information ---\n${contextAdditions}`;
      
      // Preparar actualización para el comando
      const updateData: any = {
        context: newContext
      };
      
      // Solo incluir functions si se modificaron
      if (functionsModified) {
        updateData.functions = updatedFunctions;
      }
      
      console.log(`[ToolExecutor] Adding tool results to command context with ${contextParts.length} entries`);
      
      // Actualizar el contexto y las funciones en el comando
      try {
        await commandService.updateCommand(commandId, updateData);
        console.log(`[ToolExecutor] Command context updated successfully with ${updatedFunctions.length} functions`);
        
        // Verificación adicional de estado de las funciones para el log
        if (functionsModified) {
          const failedFunctions = updatedFunctions.filter(f => f.status === 'failed').length;
          const completedFunctions = updatedFunctions.filter(f => f.status === 'completed').length;
          const possibleMatchFuncs = updatedFunctions.filter(f => f.status === 'possible_match').length;
          console.log(`[ToolExecutor] Estado de funciones actualizado: ${completedFunctions} completed, ${failedFunctions} failed, ${possibleMatchFuncs} possible_match`);
        }
      } catch (updateError) {
        console.error('[ToolExecutor] Error updating command via CommandService:', updateError);
      }
    } else {
      console.log(`[ToolExecutor] No tool results to add to context`);
    }
  } catch (error: any) {
    console.error('[ToolExecutor] Error in updateCommandContext:', error);
  }
} 