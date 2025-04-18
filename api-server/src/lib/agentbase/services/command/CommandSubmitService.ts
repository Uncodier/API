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
      
      // Crear un ID en formato antiguo para compatibilidad
      const legacyId = CommandFactory.generateCommandId();
      console.log(`🔑 [CommandSubmitService] ID legacy generado: ${legacyId}`);
      
      // Guardar la relación entre el ID de formato antiguo y el UUID
      CommandStore.setIdMapping(legacyId, createdCommand.id);
      console.log(`🔗 [CommandSubmitService] Mapeos registrados: ${legacyId} -> ${createdCommand.id}, ${createdCommand.id} -> ${createdCommand.id}`);
      
      // Store command in memory as a fallback (usando el ID antiguo)
      // Añadir el uuid de la BD como metadato para facilitar actualizaciones
      const memoryCommand = { 
        ...createdCommand, 
        id: legacyId,
        // Almacenar el UUID de BD como metadato
        metadata: {
          ...(createdCommand.metadata || {}),
          dbUuid: createdCommand.id,
          createTime: new Date().toISOString()
        }
      };
      
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
      
      // Guardar en memoria
      CommandStore.setCommand(legacyId, memoryCommand);
      console.log(`📦 [CommandSubmitService] Comando almacenado en memoria con ID: ${legacyId}`);
      
      // Emit event for command creation with the old ID format but include the DB UUID
      this.eventEmitter.emit('commandCreated', memoryCommand);
      console.log(`📣 [CommandSubmitService] Evento 'commandCreated' emitido para ID: ${legacyId}`);
      
      console.log(`✅ [CommandSubmitService] FIN submitCommand, devolviendo ID: ${legacyId}`);
      
      // Devolver el ID en formato antiguo
      return legacyId;
    } catch (error) {
      console.error('Error creating command in database:', error);
      
      // Fallback to in-memory storage if database fails
      console.log('Falling back to in-memory storage...');
      const commandId = CommandFactory.generateCommandId();
      const createdCommand: DbCommand = {
        ...command,
        id: commandId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
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