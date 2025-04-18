/**
 * CommandStatusService - Servicio para manejar los cambios de estado de los comandos
 */
import { DbCommand, CommandStatus } from '../../models/types';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import { CommandStore } from './CommandStore';
import { EventEmitter } from 'events';
import { CommandCache } from './CommandCache';

export class CommandStatusService {
  private eventEmitter: EventEmitter;

  constructor(eventEmitter: EventEmitter) {
    this.eventEmitter = eventEmitter;
  }

  /**
   * Actualiza el estado de un comando
   * 
   * @param commandId ID del comando
   * @param status Nuevo estado
   * @param errorMessage Mensaje de error opcional (si el estado es failed)
   * @returns Comando actualizado o null si no se encontró
   */
  async updateStatus(commandId: string, status: CommandStatus, errorMessage?: string): Promise<DbCommand | null> {
    try {
      console.log(`[CommandStatusService] Actualizando estado de ${commandId} a ${status}${errorMessage ? ' con error' : ''}`);
      
      // Get current command
      const command = CommandStore.getCommand(commandId);
      
      if (!command) {
        console.error(`[CommandStatusService] Comando no encontrado para actualización de estado: ${commandId}`);
        return null;
      }
      
      // Verificar si ya tiene el estado deseado para evitar actualizaciones innecesarias
      if (command.status === status) {
        console.log(`[CommandStatusService] El comando ${commandId} ya tiene el estado ${status}, omitiendo actualización`);
        return command;
      }
      
      // Create updated command
      const updatedCommand = { 
        ...command, 
        status,
        updated_at: new Date().toISOString()
      };
      
      // Add error message if provided and status is failed
      if (status === 'failed' && errorMessage) {
        updatedCommand.error = errorMessage;
      }
      
      // Store in command registry
      CommandStore.setCommand(commandId, updatedCommand);
      console.log(`[CommandStatusService] Estado actualizado en memoria: ${commandId} -> ${status}`);
      
      // Emit status change event
      this.eventEmitter.emit('statusChange', { 
        id: commandId, 
        dbId: command.metadata?.dbUuid,
        status 
      });
      console.log(`[CommandStatusService] Evento 'statusChange' emitido para ${commandId}`);
      
      // Try to update in database if UUID is available
      const dbUuid = command.metadata?.dbUuid || CommandStore.getMappedId(commandId) || commandId;
      
      if (DatabaseAdapter.isValidUUID(dbUuid)) {
        try {
          console.log(`[CommandStatusService] Actualizando estado en BD: ${dbUuid} -> ${status}`);
          
          await DatabaseAdapter.updateCommand(dbUuid, {
            status,
            ...(status === 'failed' && errorMessage ? { error: errorMessage } : {})
          });
          
          console.log(`[CommandStatusService] Estado actualizado en BD: ${dbUuid} -> ${status}`);
          
          // Asegurarse de que el comando en caché tenga el estado actualizado
          const cachedCommand = CommandCache.getCachedCommand(commandId);
          if (cachedCommand) {
            // Actualizar estado en caché si existe
            const updatedCachedCommand = {
              ...cachedCommand,
              status,
              updated_at: new Date().toISOString(),
              ...(status === 'failed' && errorMessage ? { error: errorMessage } : {})
            };
            CommandCache.cacheCommand(commandId, updatedCachedCommand);
            console.log(`[CommandStatusService] Estado actualizado en caché: ${commandId} -> ${status}`);
          }
        } catch (error) {
          console.error(`[CommandStatusService] Error al actualizar estado en BD: ${error}`);
          // Continuar a pesar del error, ya tenemos la actualización en memoria
        }
      } else {
        console.log(`[CommandStatusService] No se pudo actualizar en BD, ID no válido: ${dbUuid}`);
      }
      
      return updatedCommand;
    } catch (error) {
      console.error(`[CommandStatusService] Error crítico al actualizar estado: ${error}`);
      return null;
    }
  }

  /**
   * Actualiza el estado de una herramienta dentro de un comando
   * 
   * @param commandId ID del comando
   * @param toolName Nombre de la herramienta
   * @param status Nuevo estado
   * @param result Resultado opcional
   * @returns true si se realizó la actualización, false si no
   */
  async updateToolStatus(
    commandId: string, 
    toolName: string, 
    status: string, 
    result?: any
  ): Promise<boolean> {
    const command = CommandStore.getCommand(commandId);
    
    if (!command) {
      return false;
    }
    
    const tools = [...(command.tools || [])];
    const toolIndex = tools.findIndex(t => t.name === toolName);
    
    if (toolIndex === -1) {
      return false;
    }
    
    tools[toolIndex] = {
      ...tools[toolIndex],
      status,
      result
    };
    
    // Update command with modified tools
    const updatedCommand = {
      ...command,
      tools,
      updated_at: new Date().toISOString()
    };
    
    // Store updated command
    CommandStore.setCommand(commandId, updatedCommand);
    
    // Emit tool status change event
    this.eventEmitter.emit('toolStatusChange', { 
      commandId, 
      toolName, 
      status 
    });
    
    return true;
  }
} 