/**
 * CommandSubmitService - Servicio para la creación y envío de comandos
 */
import { CreateCommandParams, DbCommand } from '../../models/types';
import { CommandFactory } from './CommandFactory';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import { CommandStore } from './CommandStore';
import { EventEmitter } from 'events';

export class CommandSubmitService {
  private eventEmitter: EventEmitter;

  constructor(eventEmitter: EventEmitter) {
    this.eventEmitter = eventEmitter;
  }

  /**
   * Envía un comando para su ejecución
   * 
   * @param command Parámetros del comando
   * @returns ID del comando creado
   */
  async submitCommand(command: CreateCommandParams): Promise<string> {
    try {
      console.log(`🔄 [CommandSubmitService] INICIO submitCommand para command task: ${command.task}, agent_id: ${command.agent_id || 'N/A'}`);
      console.log(`🔄 [CommandSubmitService] Command tiene agent_background: ${command.agent_background ? 'SÍ' : 'NO'}`);
      
      // Si tiene agent_background, mostrar información detallada
      if (command.agent_background) {
        console.log(`🔍 [CommandSubmitService] Longitud agent_background: ${command.agent_background.length} caracteres`);
        console.log(`🔍 [CommandSubmitService] Primeros 100 caracteres: ${command.agent_background.substring(0, 100)}...`);
      }
      
      // Try to store command in database using the adapter
      const createdCommand = await DatabaseAdapter.createCommand(command);
      console.log(`✅ [CommandSubmitService] Comando creado en base de datos con UUID: ${createdCommand.id}`);
      
      // Verificar que el agent_background se haya conservado en la BD
      if (command.agent_background && !createdCommand.agent_background) {
        console.error(`⚠️ [CommandSubmitService] ADVERTENCIA: agent_background se perdió en la creación en BD`);
        // Intentar actualizar el comando en la BD para incluir el agent_background
        try {
          await DatabaseAdapter.updateCommand(createdCommand.id, {
            agent_background: command.agent_background
          });
          console.log(`🔧 [CommandSubmitService] agent_background restaurado en BD con actualización`);
        } catch (dbError) {
          console.error(`❌ [CommandSubmitService] Error al restaurar agent_background en BD:`, dbError);
        }
      } else if (command.agent_background && createdCommand.agent_background) {
        console.log(`✅ [CommandSubmitService] agent_background preservado correctamente en BD (${createdCommand.agent_background.length} caracteres)`);
      }
      
      // Use the persisted UUID across requests/isolates. A process-local alias
      // cannot be resolved by another worker or used in a Postgres UUID filter.
      const commandId = createdCommand.id;
      CommandStore.setIdMapping(commandId, commandId);

      // Keep the same identity in memory, events and the submission response.
      const memoryCommand: DbCommand = {
        ...createdCommand, 
        id: commandId,
        // Almacenar el UUID de BD como metadato
        metadata: {
          ...(createdCommand.metadata || {}),
          dbUuid: createdCommand.id,
          createTime: new Date().toISOString()
        }
      };
      
      // Preservar model_type y model_id para uso en memoria aunque no existan en BD
      if (command.model_type && !memoryCommand.model_type) {
        memoryCommand.model_type = command.model_type;
        console.log(`🔥 [CommandSubmitService] Preservando model_type en memoria: ${command.model_type}`);
      }
      
      if (command.model_id && !memoryCommand.model_id) {
        memoryCommand.model_id = command.model_id;
        console.log(`🔥 [CommandSubmitService] Preservando model_id en memoria: ${command.model_id}`);
      }
      
      // Si existe model pero no model_id, usar model como model_id para compatibilidad
      if (memoryCommand.model && !memoryCommand.model_id) {
        memoryCommand.model_id = memoryCommand.model;
        console.log(`🔥 [CommandSubmitService] Usando model como model_id en memoria: ${memoryCommand.model}`);
      }
      
      // Preserve tools model fields in memory (same pattern as model_type/model_id)
      if (command.tools_model_type && !memoryCommand.tools_model_type) {
        memoryCommand.tools_model_type = command.tools_model_type;
        console.log(`🔥 [CommandSubmitService] Preserving tools_model_type in memory: ${command.tools_model_type}`);
      }

      if (command.tools_model_id && !memoryCommand.tools_model_id) {
        memoryCommand.tools_model_id = command.tools_model_id;
        console.log(`🔥 [CommandSubmitService] Preserving tools_model_id in memory: ${command.tools_model_id}`);
      }

      if (command.tools_model && !memoryCommand.tools_model) {
        memoryCommand.tools_model = command.tools_model;
        console.log(`🔥 [CommandSubmitService] Preserving tools_model in memory: ${command.tools_model}`);
      }
      
      if (command.agent_role && !memoryCommand.agent_role) {
        memoryCommand.agent_role = command.agent_role;
      }
      if (command.agent_role) {
        memoryCommand.metadata = {
          ...(memoryCommand.metadata || {}),
          agent_role: command.agent_role,
        };
      }

      // Verificar si el agent_background se mantiene
      if (command.agent_background) {
        console.log(`🔍 [CommandSubmitService] Verificando si agent_background permanece en memoryCommand: ${memoryCommand.agent_background ? 'SÍ' : 'NO'}`);
        if (!memoryCommand.agent_background) {
          console.warn(`⚠️ [CommandSubmitService] ADVERTENCIA: agent_background se perdió durante la creación del comando`);
          // Restaurar el agent_background
          memoryCommand.agent_background = command.agent_background;
          console.log(`🔧 [CommandSubmitService] Restaurando agent_background en memoryCommand (${command.agent_background.length} caracteres)`);
        }
      }
      
      // Guardar comando en memoria
      CommandStore.setCommand(commandId, memoryCommand);
      console.log(`📦 [CommandSubmitService] Comando almacenado en memoria con ID: ${commandId}`);
      
      // Emit the persisted identity used by the command processor.
      this.eventEmitter.emit('commandCreated', memoryCommand);
      console.log(`📣 [CommandSubmitService] Evento 'commandCreated' emitido para ID: ${commandId}`);
      
      console.log(`✅ [CommandSubmitService] FIN submitCommand, devolviendo ID: ${commandId}`);
      
      return commandId;
    } catch (error) {
      console.error('Error creating command in database:', error);
      
      // Fallback to in-memory storage if database fails
      console.log('Falling back to in-memory storage...');
      const commandId = CommandFactory.generateCommandId();
      const createdCommand: DbCommand = {
        ...command,
        id: commandId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {
          ...(command.metadata || {}),
          ...(command.agent_role ? { agent_role: command.agent_role } : {}),
        },
      };
      
      // Asegurarse de que agent_background se preserva en el fallback
      if (command.agent_background && !createdCommand.agent_background) {
        createdCommand.agent_background = command.agent_background;
        console.log(`🔧 [CommandSubmitService] Preservando agent_background en fallback (${command.agent_background.length} caracteres)`);
      }
      
      // Store command in memory
      CommandStore.setCommand(commandId, createdCommand);
      
      // Emit event for command creation
      this.eventEmitter.emit('commandCreated', createdCommand);
      
      return commandId;
    }
  }

  /**
   * Formatea un comando para su visualización
   * 
   * @param command Comando a formatear
   * @returns Comando formateado
   */
  formatCommandForDisplay(command: DbCommand): any {
    return {
      id: command.id,
      task: command.task,
      status: command.status,
      description: command.description,
      results: command.results,
      created: command.created_at,
      updated: command.updated_at,
      duration: command.duration ? `${(command.duration / 1000).toFixed(2)}s` : null,
      priority: command.priority,
      executionOrder: command.execution_order
    };
  }
} 