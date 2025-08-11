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
    this.agentBackgroundService = AgentBackgroundService.getInstance();
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
        console.log(`🎯 [CommandProcessor] Actualizando estado final a 'completed' para comando: ${command.id}`);
        
        try {
          await this.commandService.updateStatus(command.id, 'completed');
          command.status = 'completed';
          console.log(`✅ [CommandProcessor] Estado actualizado exitosamente a 'completed' para comando: ${command.id}`);
          
          // Verificar que la actualización se persistió correctamente
          const verificationCommand = await this.commandService.getCommandById(command.id);
          if (verificationCommand && verificationCommand.status === 'completed') {
            console.log(`✅ [CommandProcessor] Verificación exitosa: comando ${command.id} está marcado como 'completed' en BD`);
          } else {
            console.warn(`⚠️ [CommandProcessor] Posible problema: comando ${command.id} no se verifica como 'completed' después de actualización`);
            // Intentar actualización directa como fallback
            const dbUuid = CommandStore.getMappedId(command.id);
            if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
              await DatabaseAdapter.updateCommand(dbUuid, { status: 'completed' });
              console.log(`🔧 [CommandProcessor] Fallback: Estado actualizado directamente en BD para UUID: ${dbUuid}`);
            }
          }
        } catch (statusUpdateError) {
          console.error(`❌ [CommandProcessor] Error crítico al actualizar estado:`, statusUpdateError);
          // Intentar actualización directa como último recurso
          try {
            const dbUuid = CommandStore.getMappedId(command.id);
            if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
              await DatabaseAdapter.updateCommand(dbUuid, { status: 'completed' });
              command.status = 'completed';
              console.log(`🔧 [CommandProcessor] Último recurso: Estado actualizado directamente para UUID: ${dbUuid}`);
            }
          } catch (fallbackError) {
            console.error(`❌ [CommandProcessor] Error en último recurso:`, fallbackError);
          }
        }
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
    console.log(`🧠 [CommandProcessor] INICIO inicialización de agente para comando: ${command.id}`);
    
    // Si ya tiene agent_background, verificar que sea válido
    if (command.agent_background) {
      if (command.agent_background.length < 50) {
        console.warn(`⚠️ [CommandProcessor] agent_background demasiado corto (${command.agent_background.length} caracteres)`);
      } else {
        console.log(`✅ [CommandProcessor] Comando ya tiene agent_background (${command.agent_background.length} caracteres)`);
        return command;
      }
    }
    
    // Si no tiene agent_background pero tiene agent_id, intentar generarlo
    if (command.agent_id) {
      console.log(`🔍 [CommandProcessor] Generando agent_background para agent_id: ${command.agent_id}`);
      
      // Decidir qué procesador usar para generar el background
      let processor: Base | null = null;
      
      // Si existe un procesador predefinido para este agent_id, usarlo
      if (this.processors[command.agent_id]) {
        console.log(`✅ [CommandProcessor] Usando procesador predefinido: ${command.agent_id}`);
        processor = this.processors[command.agent_id];
      } 
      // Si es un UUID, probablemente sea un agente en la base de datos
      else if (DatabaseAdapter.isValidUUID(command.agent_id)) {
        console.log(`✅ [CommandProcessor] agent_id es un UUID, usando procesador base para generar background`);
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
        console.log(`✅ [CommandProcessor] Background generado para agente ${command.agent_id} (${agentBackground.length} caracteres)`);
        
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
          console.log(`💾 [CommandProcessor] agent_background guardado en base de datos`);
        } catch (dbError) {
          console.error(`❌ [CommandProcessor] Error al guardar agent_background en BD:`, dbError);
          
          // Intentar con CommandService como fallback
          try {
            await this.commandService.updateCommand(command.id, {
              agent_background: agentBackground
            });
            console.log(`🔄 [CommandProcessor] Fallback: agent_background guardado via CommandService`);
          } catch (cmdError: unknown) {
            console.error(`❌ [CommandProcessor] Error crítico al guardar agent_background:`, cmdError);
            // No fail fatal aquí, seguimos con el agent_background en memoria
          }
        }
        
        // SIEMPRE guardar en caché para este flujo
        CommandCache.setAgentBackground(command.id, agentBackground);
        console.log(`🧠 [CommandProcessor] agent_background guardado en caché`);
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
    
    console.log(`🧠 [CommandProcessor] FIN inicialización de agente para comando: ${command.id}`);
    return command;
  }
  
  /**
   * Procesa las herramientas del comando
   */
  private async processTools(command: DbCommand): Promise<DbCommand> {
    console.log(`🧰 [CommandProcessor] INICIO procesamiento de herramientas para comando: ${command.id}`);
    
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
        console.log(`🔌 [CommandProcessor] Enriqueciendo comando con herramientas de Composio`);
        command = await enrichWithComposioTools(command);
      }
      
      // Evaluar herramientas
      const toolResult = await toolEvaluator.executeCommand(command);
      
      // Verificar resultado
      if (toolResult.status === 'failed') {
        console.error(`❌ [CommandProcessor] Error en evaluación de herramientas:`, toolResult.error);
        throw new Error(`Error en evaluación de herramientas: ${toolResult.error}`);
      }
      
      // Actualizar el comando con los resultados y functions
      const updatedCommand = toolResult.updatedCommand || command;
      
      // Verificar si las funciones se crearon correctamente
      if (updatedCommand.functions) {
        console.log(`✅ [CommandProcessor] Se generaron ${updatedCommand.functions.length} funciones en la evaluación`);
        
        // Loguear información sobre las funciones para diagnóstico
        updatedCommand.functions.forEach((func: any, index: number) => {
          if (func) {
            const funcName = func.function ? func.function.name : (func.name || 'unknown');
            console.log(`📌 [CommandProcessor] Función #${index + 1}: ${funcName}`);
          } else {
            console.warn(`⚠️ [CommandProcessor] Función #${index + 1} es null o undefined`);
          }
        });
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
        if (updatedCommand.functions) {
          updateData.functions = updatedCommand.functions;
          console.log(`💾 [CommandProcessor] Guardando ${updatedCommand.functions.length} funciones en base de datos`);
        }
        
        await this.commandService.updateCommand(command.id, updateData);
        console.log(`💾 [CommandProcessor] Tokens y funciones actualizados en base de datos`);
        
        // Verificar tras la actualización
        const comandoActualizado = await this.commandService.getCommandById(command.id);
        if (comandoActualizado && comandoActualizado.functions) {
          console.log(`✅ [CommandProcessor] Verificación: el comando tiene ${comandoActualizado.functions.length} funciones después de la actualización`);
        } else {
          console.warn(`⚠️ [CommandProcessor] Las funciones no fueron persistidas correctamente`);
        }
      } catch (updateError) {
        console.error(`❌ [CommandProcessor] Error al actualizar tokens y funciones:`, updateError);
      }
      
      console.log(`🧰 [CommandProcessor] FIN procesamiento de herramientas para comando: ${command.id}`);
      return updatedCommand;
    } catch (error) {
      console.error(`❌ [CommandProcessor] Error procesando herramientas:`, error);
      throw error;
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
          console.log(`✅ [CommandProcessor] Comando actualizado tiene ${targetProcessorResults.updatedCommand.results?.length || 0} resultados`);
        } else {
          console.warn(`⚠️ [CommandProcessor] TargetProcessor no retornó comando actualizado!`);
          console.log(`🔍 [CommandProcessor] DEBUG: targetProcessorResults keys: ${Object.keys(targetProcessorResults).join(', ')}`);
          console.log(`🔍 [CommandProcessor] DEBUG: targetProcessorResults.updatedCommand type: ${typeof targetProcessorResults.updatedCommand}`);
          console.log(`🔍 [CommandProcessor] DEBUG: targetProcessorResults.updatedCommand value: ${JSON.stringify(targetProcessorResults.updatedCommand)?.substring(0, 200)}...`);
        }
      } else {
        console.error(`❌ [CommandProcessor] Procesamiento de targets falló: ${targetProcessorResults.error}`);
      }
      
      // Actualizar el comando con los resultados
      let updatedCommand = targetProcessorResults.updatedCommand || command;
      
      // Si TargetProcessor no devolvió updatedCommand pero sí hay resultados, crear uno manualmente
      if (!targetProcessorResults.updatedCommand && targetProcessorResults.results && targetProcessorResults.results.length > 0) {
        console.log(`🔧 [CommandProcessor] Creando updatedCommand manualmente con ${targetProcessorResults.results.length} resultados`);
        updatedCommand = {
          ...command,
          results: targetProcessorResults.results,
          updated_at: new Date().toISOString()
        };
      }
      
      // Preservar explícitamente el agent_background
      if (command.agent_background && (!updatedCommand.agent_background || updatedCommand.agent_background.length < command.agent_background.length)) {
        console.log(`🔄 [CommandProcessor] Restaurando agent_background en comando actualizado`);
        updatedCommand.agent_background = command.agent_background;
      }
      
      // MODIFICACIÓN: No duplicar o mezclar resultados, usar directamente los del TargetProcessor
      if (targetProcessorResults.results && targetProcessorResults.results.length > 0) {
        // Usar directamente los resultados del TargetProcessor
        updatedCommand.results = targetProcessorResults.results;
        console.log(`🔄 [CommandProcessor] Usando directamente los ${targetProcessorResults.results.length} resultados de TargetProcessor`);
      }
      
      // Actualizar tokens
      updatedCommand.input_tokens = (command.input_tokens || 0) + (targetProcessorResults.inputTokens || 0);
      updatedCommand.output_tokens = (command.output_tokens || 0) + (targetProcessorResults.outputTokens || 0);
      
      // Actualizar los resultados en base de datos a través del CommandService
      try {
        if (updatedCommand.results && updatedCommand.results.length > 0) {
          // MODIFICACIÓN: Actualizar directamente el comando completo en lugar de solo los resultados
          // MODIFICACIÓN: NO incluir agent_background en la actualización para evitar sobrescribir resultados
          await this.commandService.updateCommand(command.id, {
            results: updatedCommand.results,
            input_tokens: updatedCommand.input_tokens,
            output_tokens: updatedCommand.output_tokens
          });
          console.log(`💾 [CommandProcessor] ${updatedCommand.results.length} resultados actualizados en base de datos`);
        }
      } catch (error) {
        console.error(`❌ [CommandProcessor] Error al actualizar resultados en BD:`, error);
      }
      
      return updatedCommand;
    } catch (error: any) {
      console.error(`❌ [CommandProcessor] Error procesando targets: ${error.message}`);
      throw error;
    }
  }
}

export default CommandProcessor; 