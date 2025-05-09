/**
 * Módulo para actualizar el estado del comando
 * 
 * Este módulo proporciona funcionalidad para actualizar el estado
 * general del comando después de la ejecución de herramientas.
 */
import { ToolExecutionResult } from '../types';
import { CommandService } from '../../../services/command';

/**
 * Update command status after all functions have been executed
 * @param commandId - ID of the command to update
 * @param functionResults - Results of function executions
 */
export async function updateCommandStatus(
  commandId: string | null,
  functionResults: ToolExecutionResult[]
): Promise<void> {
  if (!commandId) {
    console.log('[ToolExecutor] No command ID provided, skipping command status update');
    return;
  }

  console.log(`[ToolExecutor] Actualizando información de ejecución para comando: ${commandId}`);
  
  try {
    // Instanciar el servicio de comandos
    const commandService = new CommandService();
    
    // Obtener comando actual para poder preservar sus funciones actualizadas
    const currentCommand = await commandService.getCommandById(commandId);
    if (!currentCommand) {
      console.error(`[ToolExecutor] Could not find command with ID: ${commandId}`);
      return;
    }
    
    // Contar funciones exitosas y fallidas
    const successCount = functionResults.filter(result => result.status === 'success').length;
    const errorCount = functionResults.filter(result => result.status === 'error').length;
    
    // Verificar si hay funciones críticas fallidas
    let hasCriticalFailures = false;
    
    // Para determinar si hay funciones críticas fallidas, necesitamos verificar en el comando actual
    if (currentCommand.functions && currentCommand.functions.length > 0) {
      const failedFunctions = currentCommand.functions.filter(f => f.status === 'failed');
      
      console.log(`[ToolExecutor] 📊 Análisis de funciones fallidas: ${failedFunctions.length} de ${currentCommand.functions.length} totales`);
      
      // Mostrar detalle de todas las funciones para diagnóstico
      console.log(`[ToolExecutor] 🔍 Estado actual de todas las funciones:`);
      for (const func of currentCommand.functions) {
        console.log(`[ToolExecutor] 🔍 Función: id=${func.id}, name=${func.name}, status=${func.status}, critical=${func.critical ? 'sí' : 'no'}`);
      }
      
      // Verificar cuáles de estas funciones son críticas
      const criticalFailedFunctions = failedFunctions.filter(f => 
        f.critical === true || 
        (f.function && f.function.critical === true)
      );
      
      hasCriticalFailures = criticalFailedFunctions.length > 0;
      
      if (hasCriticalFailures) {
        console.log(`[ToolExecutor] ⚠️ Se encontraron ${criticalFailedFunctions.length} funciones CRÍTICAS fallidas de ${failedFunctions.length} funciones fallidas totales`);
        
        // Mostrar detalle de funciones críticas fallidas
        for (const critFunc of criticalFailedFunctions) {
          console.log(`[ToolExecutor] 🚨 Función crítica fallida: ${critFunc.name}, error: ${critFunc.error ? 'presente' : 'ninguno'}`);
        }
      } else if (failedFunctions.length > 0) {
        console.log(`[ToolExecutor] ℹ️ Hay ${failedFunctions.length} funciones fallidas, pero NINGUNA es crítica`);
        
        // Mostrar detalle de funciones no críticas fallidas
        for (const failedFunc of failedFunctions) {
          console.log(`[ToolExecutor] ⚠️ Función no crítica fallida: ${failedFunc.name}, error: ${failedFunc.error ? 'presente' : 'ninguno'}`);
        }
      }
    }
    
    // El estado solo se actualiza a 'failed' si hay funciones críticas fallidas
    if (hasCriticalFailures) {
      console.log(`[ToolExecutor] Funciones críticas fallaron, actualizando estado a: failed`);
      
      try {
        // Crear objeto de actualización que incluya las funciones actualizadas
        const updateData: any = {
          status: 'failed',
          statusReason: 'Funciones críticas fallaron en su ejecución'
        };
        
        // Preservar las funciones actualizadas
        if (currentCommand.functions && currentCommand.functions.length > 0) {
          updateData.functions = currentCommand.functions;
          console.log(`[ToolExecutor] Preservando ${currentCommand.functions.length} funciones actualizadas al cambiar estado`);
          
          // Verificar estados de funciones que se van a guardar
          const failedFunctions = currentCommand.functions.filter(f => f.status === 'failed').length;
          const completedFunctions = currentCommand.functions.filter(f => f.status === 'completed').length;
          const requiredFunctions = currentCommand.functions.filter(f => f.status === 'required').length;
          console.log(`[ToolExecutor] Funciones a preservar: ${completedFunctions} completed, ${failedFunctions} failed, ${requiredFunctions} required`);
        }
        
        // Actualizar comando completo, no solo el estado
        await commandService.updateCommand(commandId, updateData);
        console.log(`[ToolExecutor] Estado actualizado a 'failed' debido a fallas críticas`);
      } catch (updateError) {
        console.error('[ToolExecutor] Error updating command status to failed:', updateError);
      }
    } else {
      // Solo agregamos información pero no cambiamos el estado
      console.log(`[ToolExecutor] Resultado de ejecución: ${successCount} exitosas, ${errorCount} fallidas (ninguna crítica)`);
      console.log(`[ToolExecutor] NO se actualiza estado a failed porque no hay fallas críticas`);
      
      // Preservar de todas formas las funciones con sus estados actualizados
      if (currentCommand.functions && currentCommand.functions.length > 0) {
        try {
          const updateData: any = {
            // No cambiamos status, solo preservamos functions
            functions: currentCommand.functions
          };
          
          // Verificar estados de funciones que se van a guardar
          const failedFunctions = currentCommand.functions.filter(f => f.status === 'failed').length;
          const completedFunctions = currentCommand.functions.filter(f => f.status === 'completed').length;
          const requiredFunctions = currentCommand.functions.filter(f => f.status === 'required').length;
          
          console.log(`[ToolExecutor] Preservando funciones sin cambiar status: ${completedFunctions} completed, ${failedFunctions} failed, ${requiredFunctions} required`);
          
          // Actualizar comando solo para preservar funciones
          await commandService.updateCommand(commandId, updateData);
          console.log(`[ToolExecutor] Funciones preservadas exitosamente sin cambiar status`);
        } catch (updateError) {
          console.error('[ToolExecutor] Error preservando funciones:', updateError);
        }
      }
    }
  } catch (error: any) {
    console.error('[ToolExecutor] Error in updateCommandStatus:', error);
  }
} 