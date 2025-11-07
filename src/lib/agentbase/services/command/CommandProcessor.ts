/**
 * CommandProcessor - Servicio encargado de procesar comandos completos
 * 
 * FLUJO CENTRALIZADO DE PROCESAMIENTO:
 * 1. Inicialización del agente - Se genera/obtiene agent_background
 * 2. Procesamiento de herramientas - Se evalúan y deciden qué tools usar
 * 3. Ejecución de targets - Se generan las respuestas finales
 * 4. Actualización de estado y resultados - Se completa el comando
 */
import { CommandService } from './CommandService';
import { Base } from '../../agents/Base';
import { DbCommand, CommandExecutionResult, CommandStatus } from '../../models/types';
import { ToolEvaluator } from '../../agents/ToolEvaluator';
import { TargetProcessor } from '../../agents/TargetProcessor';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import { CommandCache } from './CommandCache';
import { CommandStore } from './CommandStore';
import { AgentBackgroundService } from '../agent/AgentBackgroundService';

// Importar utilidades de Composio
import { ComposioConfiguration, enrichWithComposioTools, isComposioEnabled } from '../../utils/composioIntegration';

export class CommandProcessor {
  private commandService: CommandService;
  private processors: Record<string, any>;
  private agentBackgroundService: AgentBackgroundService;
  
  constructor(commandService: CommandService, processors: Record<string, any>) {
    this.commandService = commandService;
    this.processors = processors;
    this.agentBackgroundService = new AgentBackgroundService(); // Fresh instance for Edge Functions
    console.log(`🔄 CommandProcessor: Inicializado con ${Object.keys(processors).length} procesadores`);
  }
  
  /**
   * Procesa un comando completo, gestionando todas las etapas del flujo
   */
  public async processCommand(command: DbCommand): Promise<DbCommand> {
    try {
      console.log(`🔄 [CommandProcessor] INICIO procesamiento de comando: ${command.id}`);
      
      // =========================================================
      // Paso 1: Inicialización del agente y agent_background
      // =========================================================
      command = await this.initializeAgent(command);
      
      // Verificar que el comando tenga agent_background después de la inicialización
      if (!command.agent_background) {
        const errorMsg = `[CommandProcessor] ERROR FATAL: El comando ${command.id} no tiene agent_background después de la inicialización`;
        console.error(errorMsg);
        
        // Actualizar estado a 'failed'
        await this.commandService.updateStatus(command.id, 'failed', errorMsg);
        command.status = 'failed';
        command.error = errorMsg;
        
        return command;
      }
      
      // =========================================================
      // Paso 2: Procesar herramientas (si existen)
      // =========================================================
      console.log(`🧰 [CommandProcessor] Evaluando herramientas para el comando: ${command.id}`);
      
      let toolProcessingFailed = false;
      
      if (command.tools && command.tools.length > 0) {
        try {
          command = await this.processTools(command);
          console.log(`✅ [CommandProcessor] Herramientas procesadas para el comando: ${command.id}`);
        } catch (toolError: any) {
          console.error(`❌ [CommandProcessor] Error procesando herramientas:`, toolError);
          
          // No actualizamos el estado a 'failed' inmediatamente, lo marcamos para evaluar después
          toolProcessingFailed = true;
          command.error = `Error en herramientas: ${toolError.message}`;
        }
      } else {
        console.log(`ℹ️ [CommandProcessor] El comando ${command.id} no tiene herramientas para procesar`);
      }
      
      // =========================================================
      // Paso 3: Procesar los targets
      // =========================================================
      if (command.targets && command.targets.length > 0) {
        console.log(`🎯 [CommandProcessor] Procesando targets para el comando: ${command.id}`);
        
        try {
          command = await this.processTargets(command);
          console.log(`✅ [CommandProcessor] Targets procesados para el comando: ${command.id}`);
        } catch (targetError: any) {
          console.error(`❌ [CommandProcessor] Error procesando targets:`, targetError);
          
          // Actualizar estado a 'failed'
          const errorMsg = `Error en targets: ${targetError.message}`;
          await this.commandService.updateStatus(command.id, 'failed', errorMsg);
          command.status = 'failed';
          command.error = errorMsg;
          
          return command;
        }
      } else {
        console.log(`ℹ️ [CommandProcessor] El comando ${command.id} no tiene targets para procesar`);
      }
      
      // =========================================================
      // Paso 4: Actualizar estado y resultados
      // =========================================================
      console.log(`🏁 [CommandProcessor] Finalizando procesamiento del comando: ${command.id}`);
      
      // Si hubo errores en el procesamiento de herramientas pero los targets se procesaron correctamente,
      // decidir cuál es el estado final apropiado
      if (toolProcessingFailed) {
        // Si hay resultados válidos de targets, podemos considerar el comando como completado con advertencias
        if (command.results && command.results.length > 0) {
          console.log(`⚠️ [CommandProcessor] Hubo errores en herramientas pero se generaron resultados válidos`);
          await this.commandService.updateStatus(command.id, 'completed', 'Completado con advertencias en herramientas');
          command.status = 'completed';
        } else {
          // Si no hay resultados, marcar como fallido
          console.log(`❌ [CommandProcessor] Fallos en herramientas y sin resultados válidos, marcando como fallido`);
          await this.commandService.updateStatus(command.id, 'failed', command.error);
          command.status = 'failed';
        }
      }
      // Marcar como completado si no hay errores
      else if (command.status !== 'failed') {
        console.log(`🎯 [CommandProcessor] Marcando comando como completado: ${command.id}`);
        command.status = 'completed';
        // NOTE: El estado se actualizará en la BD en processTargets() junto con los resultados
        // Esto evita condiciones de carrera por múltiples actualizaciones
      }
      
      // Asegurar que el agent_background se mantiene al final del procesamiento
      if (command.agent_background) {
        CommandCache.setAgentBackground(command.id, command.agent_background);
      }
      
      console.log(`✅ [CommandProcessor] Procesamiento completo del comando: ${command.id}`);
      return command;
    } catch (error: any) {
      console.error(`❌ [CommandProcessor] Error general procesando comando ${command.id}:`, error);
      
      // Actualizar estado a 'failed'
      try {
        await this.commandService.updateStatus(command.id, 'failed', error.message);
      } catch (e) {
        console.error(`⚠️ [CommandProcessor] Error adicional al actualizar estado a failed:`, e);
      }
      
      // Actualizar el comando para retornarlo
      command.status = 'failed';
      command.error = error.message;
      
      return command;
    }
  }
  
  /**
   * Inicializa el agente y genera/obtiene el agent_background
   * Este paso es EXPLÍCITO y CRÍTICO para el procesamiento correcto
   */
  private async initializeAgent(command: DbCommand): Promise<DbCommand> {
    // Si ya tiene agent_background, verificar que sea válido
    if (command.agent_background) {
      if (command.agent_background.length < 50) {
        console.warn(`⚠️ [CommandProcessor] agent_background demasiado corto (${command.agent_background.length} caracteres)`);
      } else {
        return command;
      }
    }
    
    // Si no tiene agent_background pero tiene agent_id, intentar generarlo
    if (command.agent_id) {
      // Decidir qué procesador usar para generar el background
      let processor: Base | null = null;
      
      // Si existe un procesador predefinido para este agent_id, usarlo
      if (this.processors[command.agent_id]) {
        processor = this.processors[command.agent_id];
      } 
      // Si es un UUID, probablemente sea un agente en la base de datos
      else if (DatabaseAdapter.isValidUUID(command.agent_id)) {
        // Usar ToolEvaluator como procesador base porque siempre debería estar disponible
        processor = this.processors['tool_evaluator'];
      } else {
        const errorMsg = `[CommandProcessor] agent_id inválido o no reconocido: ${command.agent_id}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
      
      if (!processor) {
        const errorMsg = `[CommandProcessor] No se pudo obtener un procesador para el agent_id: ${command.agent_id}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
      
      try {
        // Generar agent_background usando el servicio dedicado
        const agentBackground = await this.agentBackgroundService.generateAgentBackground(processor, command.agent_id, command.id);
        
        // Actualizar el comando con el background generado
        command = {
          ...command,
          agent_background: agentBackground
        };
        
        // Guardar en la base de datos (esto es crucial)
        try {
          await DatabaseAdapter.updateCommand(command.id, {
            agent_background: agentBackground
          });
        } catch (dbError) {
          console.error(`❌ [CommandProcessor] Error al guardar agent_background en BD:`, dbError);
          
          // Intentar con CommandService como fallback
          try {
            await this.commandService.updateCommand(command.id, {
              agent_background: agentBackground
            });
          } catch (cmdError: unknown) {
            console.error(`❌ [CommandProcessor] Error crítico al guardar agent_background:`, cmdError);
            // No fail fatal aquí, seguimos con el agent_background en memoria
          }
        }
        
        // SIEMPRE guardar en caché para este flujo
        CommandCache.setAgentBackground(command.id, agentBackground);
      } catch (error: unknown) {
        console.error(`❌ [CommandProcessor] Error generando agent_background:`, error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Error generando agent_background: ${errorMessage}`);
      }
    } else {
      const errorMsg = `[CommandProcessor] El comando ${command.id} no tiene agent_id ni agent_background`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    
    return command;
  }
  
  /**
   * Procesa las herramientas del comando
   */
  private async processTools(command: DbCommand): Promise<DbCommand> {
    // Obtener el procesador para evaluar herramientas
    const toolEvaluator = this.processors['tool_evaluator'] as ToolEvaluator;
    
    if (!toolEvaluator) {
      const errorMsg = `[CommandProcessor] No se encontró el procesador de herramientas (tool_evaluator)`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    
    // IMPORTANTE: Asegurar que agent_background esté presente antes de procesar
    if (!command.agent_background) {
      console.error(`❌ [CommandProcessor] agent_background no está presente antes de procesar herramientas`);
      throw new Error('El agent_background es obligatorio para procesar herramientas');
    }
    
    try {
      // Enriquecer con herramientas de Composio si la integración está habilitada
      if (isComposioEnabled()) {
        command = await enrichWithComposioTools(command);
      }
      
      // Evaluar herramientas
      const toolResult = await toolEvaluator.executeCommand(command);
      
      // Actualizar el comando con los resultados y functions
      let updatedCommand = toolResult.updatedCommand || command;
      
      // Verificar resultado - NO throw, solo marcar el fallo
      if (toolResult.status === 'failed') {
        console.error(`❌ [CommandProcessor] Error en evaluación de herramientas (no fatal):`, toolResult.error);
        // Marcar que la ejecución de tools falló pero continuar
        updatedCommand.tool_execution_failed = true;
        updatedCommand.tool_execution_error = toolResult.error;
      }
      
      // Verificar si las funciones se crearon correctamente
      if (updatedCommand.functions) {
        // Validar y limpiar funciones para evitar problemas de serialización
        const validatedFunctions: any[] = [];
        updatedCommand.functions.forEach((func: any, index: number) => {
          if (func) {
            const funcName = func.function ? func.function.name : (func.name || 'unknown');
            
            // Validar que el output no sea demasiado grande o tenga problemas de serialización
            if (func.output) {
              try {
                const outputStr = typeof func.output === 'string' ? func.output : JSON.stringify(func.output);
                const maxOutputSize = 5 * 1024 * 1024; // 5MB limit
                
                if (outputStr.length > maxOutputSize) {
                  console.warn(`⚠️ [CommandProcessor] Función ${funcName} tiene output muy grande (${Math.round(outputStr.length / 1024)}KB), truncando`);
                  
                  // Para QUALIFY_LEAD, mantener solo datos esenciales
                  if (funcName === 'QUALIFY_LEAD' && typeof func.output === 'object' && func.output.success) {
                    func.output = {
                      success: func.output.success,
                      lead: func.output.lead ? {
                        id: func.output.lead.id,
                        email: func.output.lead.email,
                        name: func.output.lead.name,
                        status: func.output.lead.status,
                        updated_at: func.output.lead.updated_at
                      } : null,
                      status_changed: func.output.status_changed,
                      status_change: func.output.status_change,
                      next_actions: func.output.next_actions
                    };
                  } else {
                    // Para otros tools, truncar el output
                    func.output = outputStr.substring(0, maxOutputSize) + '... [truncated]';
                  }
                }
                
                // Intentar serializar para detectar problemas
                JSON.stringify(func.output);
                validatedFunctions.push(func);
              } catch (serializationError: any) {
                console.error(`❌ [CommandProcessor] Error serializando output de función ${funcName}:`, serializationError.message);
                // Mantener la función pero con output simplificado
                func.output = `[Serialization error: ${serializationError.message}]`;
                validatedFunctions.push(func);
              }
            } else {
              validatedFunctions.push(func);
            }
          } else {
            console.warn(`⚠️ [CommandProcessor] Función #${index + 1} es null o undefined`);
          }
        });
        
        // Reemplazar funciones con versiones validadas
        updatedCommand.functions = validatedFunctions;
      } else {
        console.warn(`⚠️ [CommandProcessor] No se generaron funciones en la evaluación de herramientas`);
        // Inicializar el array de funciones si no existe
        updatedCommand.functions = [];
      }
      
      // Preservar explícitamente el agent_background
      if (command.agent_background && (!updatedCommand.agent_background || updatedCommand.agent_background.length < command.agent_background.length)) {
        console.log(`🔄 [CommandProcessor] Restaurando agent_background en comando actualizado`);
        updatedCommand.agent_background = command.agent_background;
      }
      
      // Actualizar tokens
      updatedCommand.input_tokens = (command.input_tokens || 0) + (toolResult.inputTokens || 0);
      updatedCommand.output_tokens = (command.output_tokens || 0) + (toolResult.outputTokens || 0);
      
      // Guardar tokens y funciones en la base de datos
      try {
        // IMPORTANTE: Asegurar que las funciones se incluyen en la actualización
        const updateData: any = {
          input_tokens: updatedCommand.input_tokens,
          output_tokens: updatedCommand.output_tokens
        };
        
        // Solo incluir funciones si están definidas y no vacías
        if (updatedCommand.functions && updatedCommand.functions.length > 0) {
          // Validar que las funciones se pueden serializar antes de guardar
          try {
            const functionsStr = JSON.stringify(updatedCommand.functions);
            const maxFunctionsSize = 10 * 1024 * 1024; // 10MB limit
            
            if (functionsStr.length > maxFunctionsSize) {
              console.warn(`⚠️ [CommandProcessor] Funciones demasiado grandes (${Math.round(functionsStr.length / 1024)}KB), simplificando outputs`);
              
              // Simplificar outputs de funciones grandes
              updatedCommand.functions = updatedCommand.functions.map((func: any) => {
                if (func.output && typeof func.output === 'object') {
                  const funcName = func.function ? func.function.name : (func.name || 'unknown');
                  if (funcName === 'QUALIFY_LEAD' && func.output.success && func.output.lead) {
                    func.output = {
                      success: func.output.success,
                      lead: {
                        id: func.output.lead.id,
                        email: func.output.lead.email,
                        name: func.output.lead.name,
                        status: func.output.lead.status,
                        updated_at: func.output.lead.updated_at
                      },
                      status_changed: func.output.status_changed,
                      status_change: func.output.status_change,
                      next_actions: func.output.next_actions
                    };
                  }
                }
                return func;
              });
            }
            
            updateData.functions = updatedCommand.functions;
          } catch (serializationError: any) {
            console.error(`❌ [CommandProcessor] Error serializando funciones antes de guardar:`, serializationError.message);
            // No incluir funciones si no se pueden serializar, pero continuar
            console.warn(`⚠️ [CommandProcessor] Omitiendo funciones en actualización debido a error de serialización`);
          }
        }
        
        await this.commandService.updateCommand(command.id, updateData);
        
        // Verificar tras la actualización solo si hay problemas
        const comandoActualizado = await this.commandService.getCommandById(command.id);
        if (updatedCommand.functions && updatedCommand.functions.length > 0) {
          if (!comandoActualizado || !comandoActualizado.functions || comandoActualizado.functions.length === 0) {
            console.warn(`⚠️ [CommandProcessor] Las funciones no fueron persistidas correctamente`);
          }
        }
      } catch (updateError: any) {
        console.error(`❌ [CommandProcessor] Error al actualizar tokens y funciones:`, updateError.message);
        // No throw - continuar procesamiento aunque falle la actualización
      }
      
      return updatedCommand;
    } catch (error: any) {
      console.error(`❌ [CommandProcessor] Error procesando herramientas (no fatal):`, {
        message: error.message,
        name: error.name,
        code: error.code,
        stack: error.stack?.substring(0, 500)
      });
      // NO throw - marcar el error y continuar
      const updatedCommand = { ...command };
      updatedCommand.tool_execution_failed = true;
      updatedCommand.tool_execution_error = error.message || 'Unknown tool processing error';
      
      // Asegurar que functions existe incluso si hay error
      if (!updatedCommand.functions) {
        updatedCommand.functions = [];
      }
      
      console.warn(`⚠️ [CommandProcessor] Continuando procesamiento a pesar del error en herramientas`);
      return updatedCommand;
    }
  }
  
  /**
   * Procesa los targets del comando
   */
  private async processTargets(command: DbCommand): Promise<DbCommand> {
    console.log(`🎯 [CommandProcessor] INICIO procesamiento de targets para comando: ${command.id}`);
    
    // Obtener el procesador para targets
    const targetProcessor = this.processors['target_processor'] as TargetProcessor;
    
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
      
      // SINGLE POINT OF DATABASE UPDATE - Evita condiciones de carrera
      // Actualizar los resultados y estado en base de datos en una sola operación atómica
      try {
        if (updatedCommand.results && updatedCommand.results.length > 0) {
          console.log(`💾 [CommandProcessor] Actualizando comando completo en BD: ${command.id} -> ${updatedCommand.status}`);
          
          await this.commandService.updateCommand(command.id, {
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
          
          await this.commandService.updateStatus(command.id, updatedCommand.status, updatedCommand.error);
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
}

export default CommandProcessor; 