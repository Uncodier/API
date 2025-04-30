/**
 * Módulo para actualizar el estado de las funciones
 * 
 * Este módulo proporciona funcionalidad para actualizar el estado
 * de las funciones después de su ejecución.
 */
import { ToolExecutionResult } from '../types';
import { CommandService } from '../../../services/command';

/**
 * Update function status in command to completed for successful executions
 * @param commandId - ID of the command to update
 * @param functionResults - Results of function executions
 * @returns Whether all functions were completed successfully
 */
export async function updateFunctionStatuses(
  commandId: string | null,
  functionResults: ToolExecutionResult[]
): Promise<boolean> {
  if (!commandId) {
    console.log('[ToolExecutor] No command ID provided, skipping function status updates');
    return false;
  }

  console.log(`[ToolExecutor] Updating function statuses for command: ${commandId}`);
  let allSuccessful = true;

  try {
    // Instanciar el servicio de comandos
    const commandService = new CommandService();
    console.log(`[ToolExecutor] 🔄 updateFunctionStatuses iniciado para comando: ${commandId}`);
    
    // Obtener el comando actual
    const command = await commandService.getCommandById(commandId);
    if (!command) {
      console.error(`[ToolExecutor] Could not find command with ID: ${commandId}`);
      return false;
    }
    
    console.log(`[ToolExecutor] 🔍 DEBUG - Resultados de funciones para procesar:`);
    for (const result of functionResults) {
      console.log(`[ToolExecutor] 🧾 Resultado para actualizar: id=${result.id}, function_name=${result.function_name}, status=${result.status}`);
    }
    
    // Comprobar si hay funciones en el comando (primero functions, luego tools por compatibilidad)
    if (command.functions && command.functions.length > 0) {
      // Crear una copia de las funciones para actualización
      const updatedFunctions = [...command.functions];
      let functionsUpdated = false;
      
      console.log(`[ToolExecutor] 🔍 Command.functions antes de actualizar: ${updatedFunctions.length} funciones`);
      for (const func of updatedFunctions) {
        console.log(`[ToolExecutor] 📄 Función existente: id=${func.id}, name=${func.name}, status=${func.status}`);
      }
      
      // Procesar cada resultado de función individualmente
      for (const result of functionResults) {
        // Verificar explícitamente si el estado es 'error' para establecer 'failed'
        const status = result.status === 'success' ? 'completed' : 'failed';
        console.log(`[ToolExecutor] 🔄 Actualizando función ${result.id}/${result.function_name} a estado: ${status}`);
        
        // Buscar primero por el nombre de la función, que es más confiable
        let functionIndex = -1;
        if (result.function_name) {
          console.log(`[ToolExecutor] 🔍 Buscando función por nombre: ${result.function_name}`);
          functionIndex = updatedFunctions.findIndex(func => func.name === result.function_name);
        }
        
        // Si no se encontró por nombre, intentar buscar por ID
        if (functionIndex < 0 && result.id) {
          console.log(`[ToolExecutor] 🔍 Buscando función por ID: ${result.id}`);
          functionIndex = updatedFunctions.findIndex(func => func.id === result.id);
        }
        
        // Si aún no hay coincidencia y hay una sola función, asumimos que es la correcta
        if (functionIndex < 0 && updatedFunctions.length === 1) {
          console.log(`[ToolExecutor] ⚠️ Ninguna coincidencia encontrada, pero solo hay una función. Asumiendo que es la correcta.`);
          functionIndex = 0;
        }
        
        if (functionIndex >= 0) {
          // Debug actual del estado
          const currentFunc = updatedFunctions[functionIndex];
          console.log(`[ToolExecutor] 🔄 Coincidencia encontrada: Función ${currentFunc.name} (id: ${currentFunc.id})`);
          console.log(`[ToolExecutor] 📊 ANTES -> status: ${currentFunc.status}`);
          
          // Actualizar el estado de la función en el array
          updatedFunctions[functionIndex] = {
            ...updatedFunctions[functionIndex],
            status,
            result: result.output || null,
            error: result.error || null
          };
          functionsUpdated = true;
          
          // Verificación de que el estado se actualizó correctamente
          console.log(`[ToolExecutor] 📊 DESPUÉS -> status: ${updatedFunctions[functionIndex].status}`);
        } else {
          console.error(`[ToolExecutor] ❌ No se encontró la función para actualizar: ${result.function_name || result.id}`);
          
          // Crear una nueva entrada con el resultado
          console.log(`[ToolExecutor] 🆕 Creando nueva función para el resultado: ${result.function_name || result.id}`);
          
          const newFunction = {
            id: result.id || `func_${Date.now()}`,
            type: "function",
            status: status, // Usar el estado calculado (failed o completed)
            name: result.function_name || 'unknown_function',
            arguments: result.arguments || '{}',
            result: result.output || null,
            error: result.error || null
          };
          
          console.log(`[ToolExecutor] ✨ Nueva función creada: ${newFunction.name} con status=${newFunction.status}`);
          updatedFunctions.push(newFunction);
          functionsUpdated = true;
        }
      }
      
      // Si hubo cambios en las funciones, actualizar el comando
      if (functionsUpdated) {
        try {
          console.log(`[ToolExecutor] 💾 Guardando ${updatedFunctions.length} funciones actualizadas en la base de datos`);
          console.log(`[ToolExecutor] 📊 Resumen de estados: ${
            updatedFunctions.map(f => `${f.name}=${f.status}`).join(', ')
          }`);
          
          // Guardamos explícitamente todas las funciones
          await commandService.updateCommand(commandId, {
            functions: updatedFunctions
          });
          
          console.log(`[ToolExecutor] ✅ Comando actualizado exitosamente con ${updatedFunctions.length} funciones`);
          
          // Verificación después de guardar
          const verifyCommand = await commandService.getCommandById(commandId);
          if (verifyCommand && verifyCommand.functions && verifyCommand.functions.length > 0) {
            const failedFunctions = verifyCommand.functions.filter(f => f.status === 'failed').length;
            const completedFunctions = verifyCommand.functions.filter(f => f.status === 'completed').length;
            const requiredFunctions = verifyCommand.functions.filter(f => f.status === 'required').length;
            
            console.log(`[ToolExecutor] ✅ VERIFICACIÓN post-guardado: ${completedFunctions} completed, ${failedFunctions} failed, ${requiredFunctions} required de ${verifyCommand.functions.length} totales`);
            
            // Mostrar detalle completo
            console.log(`[ToolExecutor] 🔍 Detalle de funciones en DB DESPUÉS de actualizar:`);
            for (const func of verifyCommand.functions) {
              console.log(`[ToolExecutor] 📄 Función en DB: id=${func.id}, name=${func.name}, status=${func.status}, error=${func.error ? 'presente' : 'ninguno'}`);
            }
            
            // Verificar si alguna función sigue en estado 'required' cuando debería estar en 'failed'
            const missingUpdates = [];
            for (const result of functionResults) {
              if (result.status === 'error') {
                const funcName = result.function_name;
                const matchingFunc = verifyCommand.functions.find(f => f.name === funcName);
                if (matchingFunc && matchingFunc.status === 'required') {
                  console.log(`[ToolExecutor] ⚠️ ADVERTENCIA: La función ${funcName} sigue en estado 'required' cuando debería estar 'failed'`);
                  missingUpdates.push(matchingFunc);
                }
              }
            }
            
            // Forzar actualización si hay discrepancias
            if (missingUpdates.length > 0) {
              console.log(`[ToolExecutor] 🔄 Se detectaron ${missingUpdates.length} funciones con estados inconsistentes. Forzando actualización...`);
              // Forzar actualización a failed para estas funciones
              for (const func of missingUpdates) {
                func.status = 'failed';
                func.error = 'Forced update: function execution failed but status was not updated correctly';
              }
              
              // Actualizar el comando con las correcciones
              await commandService.updateCommand(commandId, {
                functions: verifyCommand.functions
              });
              console.log(`[ToolExecutor] ✅ Actualización forzada completada para ${missingUpdates.length} funciones`);
            }
          } else {
            console.log(`[ToolExecutor] STATUS VERIFICATION: Command functions not available after update`);
          }
        } catch (updateError) {
          console.error(`[ToolExecutor] Error updating functions in command: ${updateError}`);
          allSuccessful = false;
        }
      }
    } 
    // Si no hay functions, pero hay resultados, crear las functions necesarias
    else {
      console.log(`[ToolExecutor] ⚠️ NO HAY FUNCIONES en el comando ${commandId}, pero hay ${functionResults.length} resultados. Creando funciones...`);
      
      const newFunctions = functionResults.map(result => {
        const status = result.status === 'success' ? 'completed' : 'failed';
        console.log(`[ToolExecutor] 🆕 Creando nueva función para: ${result.function_name}, status=${status}`);
        
        return {
          id: result.id || `func_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
          type: "function",
          status: status,
          name: result.function_name || 'unknown_function',
          arguments: result.arguments || '{}',
          result: result.output || null,
          error: result.error || null
        };
      });
      
      console.log(`[ToolExecutor] 💾 Guardando ${newFunctions.length} nuevas funciones creadas:`);
      for (const func of newFunctions) {
        console.log(`[ToolExecutor] 📄 Nueva función: id=${func.id}, name=${func.name}, status=${func.status}`);
      }
      
      try {
        await commandService.updateCommand(commandId, {
          functions: newFunctions
        });
        console.log(`[ToolExecutor] ✅ Funciones creadas y guardadas exitosamente.`);
        allSuccessful = true;
        
        // Verificación
        const verifyCommand = await commandService.getCommandById(commandId);
        if (verifyCommand && verifyCommand.functions && verifyCommand.functions.length > 0) {
          console.log(`[ToolExecutor] ✅ VERIFICACIÓN: Comando ahora tiene ${verifyCommand.functions.length} funciones.`);
        } else {
          console.log(`[ToolExecutor] ⚠️ VERIFICACIÓN FALLIDA: Comando sigue sin tener funciones después de crear y guardar.`);
        }
      } catch (createError) {
        console.error(`[ToolExecutor] ❌ Error al crear funciones: ${createError}`);
        allSuccessful = false;
      }
    }
  } catch (error: any) {
    console.error('[ToolExecutor] Error updating function statuses:', error);
    allSuccessful = false;
  }
  
  return allSuccessful;
} 