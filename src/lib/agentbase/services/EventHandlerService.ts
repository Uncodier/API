/**
 * EventHandlerService - Servicio para manejar los event listeners y procesamiento de eventos
 */
import { CommandService } from './command/CommandService';
import { DatabaseAdapter } from '../adapters/DatabaseAdapter';
import { DbCommand } from '../models/types';
import { AgentBackgroundService } from './agent/AgentBackgroundService';
import { ToolEvaluator } from '../agents/ToolEvaluator';
import { TargetProcessor } from '../agents/TargetProcessor';
import { ComposioConfiguration } from '../utils/composioIntegration';
import { enrichWithComposioTools } from '../utils/composioIntegration';
import { CommandCache } from './command/CommandCache';

export class EventHandlerService {
  private static instance: EventHandlerService;
  private commandService: CommandService;
  private agentBackgroundService: AgentBackgroundService;
  private processors: Record<string, any> = {};
  
  private constructor() {
    this.commandService = new CommandService();
    this.agentBackgroundService = new AgentBackgroundService();
    console.log('🔔 EventHandlerService: Inicializado');
  }
  
  public static getInstance(): EventHandlerService {
    if (!EventHandlerService.instance) {
      EventHandlerService.instance = new EventHandlerService();
    }
    return EventHandlerService.instance;
  }
  
  /**
   * Establece los procesadores a utilizar
   */
  public setProcessors(processors: Record<string, any>): void {
    this.processors = processors;
    console.log(`🔄 EventHandlerService: ${Object.keys(processors).length} procesadores configurados`);
  }
  
  /**
   * Configura los event listeners para procesar comandos
   */
  public setupEventListeners(): void {
    console.log('🎛️ EventHandlerService: Configurando event listeners');
    
    // Listener para el evento commandCreated
    this.commandService.on('commandCreated', async (command: DbCommand) => {
      console.log(`📥 Comando creado: ${command.id}, agente: ${command.agent_id}`);
      
      try {
        // Extraer el UUID de la base de datos si está disponible en los metadatos
        const dbUuid = command.metadata?.dbUuid || command.id;
        console.log(`🔍 UUID para actualizaciones: ${dbUuid}`);
        
        // Actualizar estado a 'running' inmediatamente
        console.log(`🔄 Actualizando estado del comando ${command.id} a 'running'`);
        try {
          if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
            await DatabaseAdapter.updateCommand(dbUuid, { status: 'running' as any });
          } else {
            await this.commandService.updateStatus(command.id, 'running');
          }
          console.log(`✅ Estado actualizado a 'running' para: ${command.id}`);
        } catch (stateErr) {
          console.error(`⚠️ Error al actualizar estado a 'running': ${stateErr}`);
          // Continuar a pesar del error, quizás el comando se procese correctamente
        }
        
        // Procesar el comando si tiene un agent_id
        if (command.agent_id && this.processors[command.agent_id]) {
          const processor = this.processors[command.agent_id];
          
          // Generar el background completo del agente
          const agentBackground = await this.agentBackgroundService.generateEnhancedAgentBackground(processor, command.agent_id, command.site_id, command.id);
          console.log(`✅ Background completo generado para el agente ${command.agent_id}`);
          console.log(`✅ Longitud del background: ${agentBackground.length} caracteres`);
          
          // Mostrar las primeras y últimas 100 caracteres para debugging
          console.log(`✅ Inicio del background: ${agentBackground.substring(0, 100)}...`);
          console.log(`✅ Final del background: ...${agentBackground.substring(agentBackground.length - 100)}`);
          
          // Actualizar el comando con la información del agente
          command = {
            ...command,
            agent_background: agentBackground
          };
          
          // Guardar esta información en la base de datos
          await this.updateAgentBackgroundInDb(command, agentBackground);
          
          // Procesar herramientas si están disponibles
          if (command.tools && command.tools.length > 0) {
            await this.processTools(command, dbUuid);
          }
          
          // Procesar targets si están disponibles
          if (command.targets && command.targets.length > 0) {
            await this.processTargets(command, dbUuid);
          } else {
            // Si no hay targets, completar el comando
            console.log(`⚠️ No hay targets para procesar en el comando: ${command.id}`);
            
            // Actualizar estado a 'completed' en una única operación
            const completedUpdate: Partial<Omit<DbCommand, "id" | "created_at" | "updated_at">> = {
              status: 'completed' as any
            };
            
            console.log(`🔄 Completando comando sin targets: ${command.id}`);
            if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
              await DatabaseAdapter.updateCommand(dbUuid, completedUpdate);
            } else {
              await this.commandService.updateCommand(command.id, completedUpdate);
            }
            console.log(`✅ Comando ${command.id} marcado como completado`);
          }
        } else if (!command.agent_id) {
          console.log(`⚠️ Comando ${command.id} sin agent_id, intentando procesar directamente`);
          
          // Si no hay agent_id, intentar procesar targets directamente si existen
          if (command.targets && command.targets.length > 0) {
            await this.processTargets(command, dbUuid);
          } else {
            // Si no hay targets ni agent_id, marcar como completado por defecto
            console.log(`⚠️ Comando ${command.id} sin agent_id ni targets, marcando como completado`);
            const completedUpdate: Partial<Omit<DbCommand, "id" | "created_at" | "updated_at">> = {
              status: 'completed' as any
            };
            
            if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
              await DatabaseAdapter.updateCommand(dbUuid, completedUpdate);
            } else {
              await this.commandService.updateCommand(command.id, completedUpdate);
            }
            console.log(`✅ Comando ${command.id} marcado como completado por defecto`);
          }
        } else {
          // Procesador no encontrado
          const errorMsg = `No se encontró procesador para el agent_id: ${command.agent_id}`;
          console.error(`❌ ${errorMsg}`);
          
          // Actualizar como fallido
          const failureUpdate: Partial<Omit<DbCommand, "id" | "created_at" | "updated_at">> = {
            status: 'failed' as any,
            error: errorMsg
          };
          
          if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
            await DatabaseAdapter.updateCommand(dbUuid, failureUpdate);
          } else {
            await this.commandService.updateCommand(command.id, failureUpdate);
          }
        }
      } catch (error: any) {
        console.error(`❌ Error al procesar comando ${command.id}:`, error);
        
        // Actualizar estado a 'failed' en una única operación
        try {
          const errorDbUuid = command.metadata?.dbUuid || command.id;
          const failureUpdate: Partial<Omit<DbCommand, "id" | "created_at" | "updated_at">> = {
            status: 'failed' as any,
            error: error.message
          };
          
          console.log(`🔄 Marcando comando ${command.id} como fallido debido a error`);
          if (errorDbUuid && DatabaseAdapter.isValidUUID(errorDbUuid)) {
            await DatabaseAdapter.updateCommand(errorDbUuid, failureUpdate);
          } else {
            await this.commandService.updateCommand(command.id, failureUpdate);
          }
          console.log(`✅ Comando ${command.id} marcado como fallido`);
        } catch (e) {
          console.error(`⚠️ Error adicional al actualizar estado a failed: ${e}`);
        }
      }
    });
  }
  
  /**
   * Actualiza el agent_background en la base de datos
   */
  private async updateAgentBackgroundInDb(command: DbCommand, agentBackground: string): Promise<void> {
    const dbUuid = command.metadata?.dbUuid || command.id;
    
    try {
      console.log(`🔄 Intentando guardar agent_background en DB (${agentBackground.length} caracteres). UUID: ${dbUuid}`);
      console.log(`🔍 Es UUID válido: ${DatabaseAdapter.isValidUUID(dbUuid)}`);
      
      if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
        // Intentar actualizar varias veces si es necesario
        let updateSuccess = false;
        const maxRetries = 3;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            await DatabaseAdapter.updateCommand(dbUuid, {
              agent_background: agentBackground
            });
            
            console.log(`✅ [Intento ${attempt}] agent_background guardado en DB para ID: ${dbUuid}`);
            updateSuccess = true;
            break;
          } catch (updateError) {
            console.error(`❌ [Intento ${attempt}] Error al guardar agent_background:`, updateError);
            
            if (attempt < maxRetries) {
              // Esperar antes de reintentar (500ms * número de intento)
              await new Promise(resolve => setTimeout(resolve, 500 * attempt));
              console.log(`🔄 Reintentando actualización de agent_background (intento ${attempt+1}/${maxRetries})...`);
            }
          }
        }
        
        // Verificar que el agent_background se guardó correctamente
        if (updateSuccess) {
          try {
            const verification = await DatabaseAdapter.verifyAgentBackground(dbUuid);
            if (verification.hasBackground) {
              console.log(`✅ Verificación exitosa: agent_background guardado en DB (${verification.value?.length || 0} caracteres)`);
            } else {
              console.error(`⚠️ Verificación falló: agent_background no se guardó correctamente.`);
              // Intentar usar CommandService como fallback
              await this.commandService.updateCommand(command.id, {
                agent_background: agentBackground
              });
              console.log(`🔄 Fallback: agent_background actualizado via CommandService`);
            }
          } catch (verifyError) {
            console.error(`❌ Error al verificar agent_background:`, verifyError);
          }
        } else {
          // Si fallaron todos los intentos directos, intentar con CommandService
          console.log(`⚠️ Todos los intentos directos fallaron. Usando CommandService como fallback.`);
          await this.commandService.updateCommand(command.id, {
            agent_background: agentBackground
          });
          console.log(`🔄 Fallback: agent_background actualizado via CommandService`);
        }
      } else {
        console.log(`🔄 UUID no válido o no disponible. Usando CommandService para guardar agent_background`);
        await this.commandService.updateCommand(command.id, {
          agent_background: agentBackground
        });
        console.log(`✅ agent_background guardado via CommandService para ID: ${command.id}`);
      }
    } catch (error) {
      console.error(`❌ Error general al guardar agent_background:`, error);
      // Intentar un último método de actualización en caso de error
      try {
        console.log(`🔄 Último intento de actualización de emergencia para ID: ${command.id}`);
        await this.commandService.updateCommand(command.id, {
          agent_background: agentBackground
        });
      } catch (finalError) {
        console.error(`❌ Error final al guardar agent_background:`, finalError);
      }
    }
  }
  
  /**
   * Procesa las herramientas de un comando
   */
  private async processTools(command: DbCommand, dbUuid: string): Promise<void> {
    console.log(`🛠️ Evaluando ${command.tools!.length} herramientas para el comando: ${command.id}`);
    
    try {
      // Importar utilidades de Composio
      const composioUtils = await import('../utils/composioIntegration');
      
      // Enriquecer con herramientas de Composio si la integración está habilitada
      if (composioUtils.isComposioEnabled()) {
        console.log(`🔌 [EventHandlerService] Enriqueciendo comando con herramientas de Composio`);
        command = await composioUtils.enrichWithComposioTools(command);
      }
      
      // Obtener el procesador de herramientas
      const toolEvaluator = this.processors['tool_evaluator'] as ToolEvaluator;
      
      if (!toolEvaluator) {
        throw new Error('Tool evaluator not initialized');
      }
      
      // Ejecutar la evaluación
      console.log(`🔄 Iniciando evaluación de herramientas para: ${command.id}`);
      const toolResult = await toolEvaluator.executeCommand(command);
      
      if (toolResult.status === 'completed' && toolResult.results) {
        console.log(`✅ Evaluación de herramientas completada para: ${command.id}`);
        
        // Actualizar el comando con los resultados
        command.functions = toolResult.updatedCommand?.functions || [];
        
        // Actualizar tokens en el comando
        command.input_tokens = (command.input_tokens || 0) + (toolResult.inputTokens || 0);
        command.output_tokens = (command.output_tokens || 0) + (toolResult.outputTokens || 0);
        
        // Preparar actualización para la base de datos
        const updateData = {
          functions: command.functions,
          input_tokens: command.input_tokens,
          output_tokens: command.output_tokens
        };
        
        // Actualizar en la base de datos o en el servicio de comandos
        if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
          await DatabaseAdapter.updateCommand(dbUuid, updateData);
        } else {
          await this.commandService.updateCommand(command.id, updateData);
        }
        
        // Guardar en caché - evitar error de parámetros
        CommandCache.cacheCommand(command.id, command);
        
        console.log(`📊 Tokens actualizados para ${command.id} - Input: ${command.input_tokens}, Output: ${command.output_tokens}`);
      } else {
        console.error(`❌ Error en evaluación de herramientas: ${toolResult.error}`);
        throw new Error(`Error en evaluación de herramientas: ${toolResult.error}`);
      }
    } catch (error: any) {
      console.error(`❌ Error al procesar herramientas: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Procesa los targets de un comando
   */
  private async processTargets(command: DbCommand, dbUuid: string): Promise<void> {
    console.log(`🎯 Procesando targets para el comando: ${command.id}`);
    
    try {
      // Verificar primero si hay herramientas para evaluar
      if (command.tools && command.tools.length > 0) {
        console.log(`🔄 Procesando herramientas antes de los targets para: ${command.id}`);
        await this.processTools(command, dbUuid);
      } else {
        console.log(`ℹ️ No hay herramientas para evaluar en el comando: ${command.id}`);
      }
      
      // Obtener el procesador de targets
      const targetProcessor = this.processors['target_processor'] as TargetProcessor;
      
      if (!targetProcessor) {
        throw new Error('Target processor not initialized');
      }
      
      // Comprobar si el comando tiene agent_background
      console.log(`🔍 Agent background presente: ${command.agent_background ? 'Sí' : 'No'}`);
      
      // Ejecutar el procesamiento
      const targetResult = await targetProcessor.executeCommand(command);
      
      if (targetResult.status === 'completed' && targetResult.results) {
        console.log(`✅ Procesamiento de targets completado para: ${command.id}`);
        
        // Preparar un único objeto para actualización en lote
        const updateBatch: any = {
          status: 'completed',
          results: targetResult.results
        };
        
        // Calcular tokens acumulados para añadir al lote de actualización
        const currentInputTokens = Number(command.input_tokens || 0);
        const currentOutputTokens = Number(command.output_tokens || 0);
        const inputTokens = currentInputTokens + Number(targetResult.inputTokens || 0);
        const outputTokens = currentOutputTokens + Number(targetResult.outputTokens || 0);
        
        updateBatch.input_tokens = inputTokens;
        updateBatch.output_tokens = outputTokens;
        
        // Añadir el modelo usado si está disponible en el comando actualizado
        if (targetResult.updatedCommand && targetResult.updatedCommand.model) {
          updateBatch.model = targetResult.updatedCommand.model;
          console.log(`🤖 Modelo utilizado: ${updateBatch.model}`);
        }
        
        // Preservar agent_background si existe
        if (command.agent_background) {
          console.log(`🔄 Preservando agent_background en actualización final`);
          updateBatch.agent_background = command.agent_background;
        }
        
        console.log(`🔢 Tokens acumulados: input=${inputTokens}, output=${outputTokens}`);
        
        // Realizar una única actualización en la base de datos
        if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
          console.log(`🔄 Actualizando resultados y estado en una sola operación para: ${dbUuid}`);
          await DatabaseAdapter.updateCommand(dbUuid, updateBatch);
        } else {
          // Usar el API interno si no tenemos un UUID válido
          console.log(`🔄 Actualizando resultados y estado con CommandService para: ${command.id}`);
          await this.commandService.updateCommand(command.id, updateBatch);
        }
      } else if (targetResult.status === 'failed') {
        console.error(`❌ Error en procesamiento de targets: ${targetResult.error}`);
        
        // Actualizar el estado del comando a failed en una sola operación
        const failureUpdate: Partial<Omit<DbCommand, "id" | "created_at" | "updated_at">> = {
          status: 'failed' as any,
          error: targetResult.error
        };
        
        if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
          await DatabaseAdapter.updateCommand(dbUuid, failureUpdate);
        } else {
          await this.commandService.updateCommand(command.id, failureUpdate);
        }
        
        throw new Error(`Target processing error: ${targetResult.error}`);
      }
    } catch (error: any) {
      console.error(`❌ Error al procesar targets: ${error.message}`);
      
      // Actualizar el estado del comando a failed
      if (dbUuid && DatabaseAdapter.isValidUUID(dbUuid)) {
        await DatabaseAdapter.updateCommand(dbUuid, {
          status: 'failed',
          error: `Target processing error: ${error.message}`
        });
      } else {
        await this.commandService.updateStatus(command.id, 'failed', `Target processing error: ${error.message}`);
      }
      
      throw error; // Re-lanzar el error para manejarlo en el nivel superior
    }
  }
} 