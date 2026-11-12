import type { DbCommand } from '../../models/types';
import type { CommandService } from './CommandService';
import type { TargetProcessor } from '../../agents/TargetProcessor';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import { CommandStore } from './CommandStore';

export async function processCommandTargets(command: DbCommand, processors: Record<string, any>, commandService: CommandService): Promise<DbCommand> {
    console.log(`🎯 [CommandProcessor] INICIO procesamiento de targets para comando: ${command.id}`);

    // Obtener el procesador para targets
    const targetProcessor = processors['target_processor'] as TargetProcessor;

    if (!targetProcessor) {
      const errorMsg = `[CommandProcessor] No se encontró el procesador de targets (target_processor)`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    // IMPORTANTE: Asegurar que agent_background esté presente antes de procesar
    if (!command.agent_background) {
      console.error(`❌ [CommandProcessor] agent_background no está presente antes de procesar targets`);
      throw new Error('El agent_background es obligatorio para procesar targets');
    }

    try {
      // Procesar targets
      const targetProcessorResults = await targetProcessor.executeCommand({
        ...command,
        agent_background: command.agent_background
      });

      console.log(`✅ [CommandProcessor] Resultado del TargetProcessor: status=${targetProcessorResults.status}`);

      if (targetProcessorResults.status === 'completed') {
        console.log(`✅ [CommandProcessor] Resultados obtenidos del procesamiento: ${targetProcessorResults.results?.length || 0}`);

        // Log de los primeros resultados para diagnóstico
        if (targetProcessorResults.results && targetProcessorResults.results.length > 0) {
          const resultPreview = targetProcessorResults.results.slice(0, 2).map((r, i) => {
            const keys = Object.keys(r);
            return `Resultado[${i}]: keys=${keys.join(',')}`;
          });
          console.log(`🔍 [CommandProcessor] Preview de resultados: ${resultPreview.join(' | ')}`);
        } else {
          console.warn(`⚠️ [CommandProcessor] No hay resultados aunque el procesamiento fue exitoso!`);
        }

        // Log del updatedCommand si existe
        if (targetProcessorResults.updatedCommand) {
          console.log(`✅ [CommandProcessor] Comando actualizado recibido correctamente`);
        } else {
          console.warn(`⚠️ [CommandProcessor] TargetProcessor no retornó comando actualizado!`);
        }
      } else {
        // Analizar el tipo de error para determinar si es recuperable
        const errorMessage = targetProcessorResults.error || 'Unknown error';
        console.error(`❌ [CommandProcessor] Procesamiento de targets falló: ${errorMessage}`);

        // Verificar si es un error de timeout recuperable
        if (errorMessage.includes('UND_ERR_BODY_TIMEOUT') ||
            errorMessage.includes('Body Timeout Error') ||
            errorMessage.includes('Stream processing failed: terminated') ||
            errorMessage.includes('Chunk timeout: No data received')) {
          console.warn(`⚠️ [CommandProcessor] Error de timeout detectado - verificando contenido parcial...`);

          // Si hay resultados parciales, el sistema ya los habría procesado en StreamingResponseProcessor
          if (targetProcessorResults.results && targetProcessorResults.results.length > 0) {
            console.log(`🔄 [CommandProcessor] Contenido parcial recuperado exitosamente`);
          }
        }
      }

      // Actualizar el comando con los resultados
      let updatedCommand = targetProcessorResults.updatedCommand || command;

      // Si TargetProcessor no devolvió updatedCommand pero sí hay resultados, crear uno manualmente
      if (!targetProcessorResults.updatedCommand && targetProcessorResults.results && targetProcessorResults.results.length > 0) {
        console.log(`🔧 [CommandProcessor] Creando updatedCommand manualmente`);
        updatedCommand = {
          ...command,
          results: targetProcessorResults.results,
          updated_at: new Date().toISOString()
        };
      }

      // CRITICAL FIX: Update command status based on TargetProcessor result
      if (targetProcessorResults.status === 'completed') {
        console.log(`🎯 [CommandProcessor] TargetProcessor completado exitosamente, actualizando estado del comando a 'completed'`);
        updatedCommand.status = 'completed';
        updatedCommand.updated_at = new Date().toISOString();
      } else if (targetProcessorResults.status === 'failed') {
        console.log(`❌ [CommandProcessor] TargetProcessor falló, actualizando estado del comando a 'failed'`);
        updatedCommand.status = 'failed';
        updatedCommand.error = targetProcessorResults.error;
        updatedCommand.updated_at = new Date().toISOString();
      }

      // Preservar explícitamente el agent_background
      if (command.agent_background && (!updatedCommand.agent_background || updatedCommand.agent_background.length < command.agent_background.length)) {
        console.log(`🔄 [CommandProcessor] Restaurando agent_background en comando actualizado`);
        updatedCommand.agent_background = command.agent_background;
      }

      // Usar directamente los resultados del TargetProcessor
      if (targetProcessorResults.results && targetProcessorResults.results.length > 0) {
        updatedCommand.results = targetProcessorResults.results;
      }

      // Actualizar tokens
            updatedCommand.input_tokens = (command.input_tokens || 0) + (targetProcessorResults.inputTokens || 0);
      updatedCommand.output_tokens = (command.output_tokens || 0) + (targetProcessorResults.outputTokens || 0);

      // El conector liquida cada generación por coste real; aquí sólo se registra uso.

      // SINGLE POINT OF DATABASE UPDATE - Evita condiciones de carrera
      // Actualizar los resultados y estado en base de datos en una sola operación atómica
      try {
        if (updatedCommand.results && updatedCommand.results.length > 0) {
          console.log(`💾 [CommandProcessor] Actualizando comando completo en BD: ${command.id} -> ${updatedCommand.status}`);

          await commandService.updateCommand(command.id, {
            results: updatedCommand.results,
            input_tokens: updatedCommand.input_tokens,
            output_tokens: updatedCommand.output_tokens,
            status: updatedCommand.status, // Estado incluido en la actualización atómica
            error: updatedCommand.error // Include error if present
          });

          console.log(`✅ [CommandProcessor] Comando actualizado exitosamente en BD: ${updatedCommand.status}`);

        } else if (updatedCommand.status === 'completed' || updatedCommand.status === 'failed') {
          // Si no hay resultados pero el estado cambió, actualizar solo el estado
          console.log(`🔄 [CommandProcessor] Actualizando solo estado en BD: ${command.id} -> ${updatedCommand.status}`);

          await commandService.updateStatus(command.id, updatedCommand.status, updatedCommand.error);
          console.log(`✅ [CommandProcessor] Estado actualizado exitosamente en BD: ${updatedCommand.status}`);
        }

      } catch (error) {
        console.error(`❌ [CommandProcessor] Error crítico al actualizar comando en BD:`, error);

        // FALLBACK: Intentar actualización directa como último recurso
        if (updatedCommand.status === 'completed' || updatedCommand.status === 'failed') {
          try {
            console.log(`🔧 [CommandProcessor] Fallback: Actualización directa en BD`);
            const dbUuid = CommandStore.getMappedId(command.id);

            if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
              await DatabaseAdapter.updateCommand(dbUuid, {
                status: updatedCommand.status,
                ...(updatedCommand.results && { results: updatedCommand.results }),
                ...(updatedCommand.error && { error: updatedCommand.error })
              });
              console.log(`✅ [CommandProcessor] Fallback exitoso: UUID ${dbUuid} -> ${updatedCommand.status}`);
            } else {
              console.warn(`⚠️ [CommandProcessor] No se pudo obtener UUID válido para fallback: ${dbUuid}`);
            }
          } catch (fallbackError) {
            console.error(`❌ [CommandProcessor] Fallback falló completamente:`, fallbackError);
          }
        }
      }

      // SAFETY: Ensure the updated command is stored in CommandStore with the correct status
      if (updatedCommand.status === 'completed' || updatedCommand.status === 'failed') {
        console.log(`🔒 [CommandProcessor] Asegurando que el comando esté almacenado en CommandStore con estado '${updatedCommand.status}'`);
        CommandStore.setCommand(command.id, updatedCommand);
      }

      return updatedCommand;
    } catch (error: any) {
      console.error(`❌ [CommandProcessor] Error procesando targets: ${error.message}`);
      throw error;
    }
  }
