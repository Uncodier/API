/**
 * CommandQueryService - Servicio para consultas de comandos
 */
import { DbCommand } from '../../models/types';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import { CommandStore } from './CommandStore';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { EventEmitter } from 'events';
import { CommandCache } from './CommandCache';

export type GetCommandByIdOptions = {
  /** Always read Postgres. Use from pollers so isolate cache cannot hide DB status. */
  fresh?: boolean;
};

function shouldReadDatabase(cachedCommand: DbCommand | null, options?: GetCommandByIdOptions): boolean {
  if (options?.fresh) return true;
  if (!cachedCommand) return true;
  return cachedCommand.status === 'pending' || cachedCommand.status === 'running';
}

export class CommandQueryService {
  private eventEmitter: EventEmitter | null = null;
  
  constructor(eventEmitter?: EventEmitter) {
    this.eventEmitter = eventEmitter || null;
  }
  
  setEventEmitter(eventEmitter: EventEmitter): void {
    this.eventEmitter = eventEmitter;
  }
  
  /**
   * Get a command by ID. Cache is for the executing isolate only.
   * Pollers must pass `{ fresh: true }` so a `running` cache cannot hide DB `completed`.
   */
  async getCommandById(commandId: string, options?: GetCommandByIdOptions): Promise<DbCommand | null> {
    try {
      const cachedCommand = CommandCache.getCachedCommand(commandId);

      if (!shouldReadDatabase(cachedCommand, options)) {
        return cachedCommand;
      }

      const dbId = CommandStore.getMappedId(commandId) || commandId;
      const command = await DatabaseAdapter.getCommandById(dbId);

      if (command) {
        const resultCommand = { ...command };
        if (commandId !== dbId) {
          resultCommand.id = commandId;
        }

        if (cachedCommand?.agent_background && !resultCommand.agent_background) {
          console.log(`🔄 [CommandQueryService] Preserving agent_background from cache (${cachedCommand.agent_background.length} characters)`);
          resultCommand.agent_background = cachedCommand.agent_background;
        }

        CommandStore.setCommand(commandId, resultCommand);
        CommandCache.cacheCommand(commandId, resultCommand);
        return resultCommand;
      }

      if (cachedCommand) {
        return cachedCommand;
      }

      const memoryCommand = CommandStore.getCommand(commandId);
      if (memoryCommand) {
        CommandCache.cacheCommand(commandId, memoryCommand);
        return memoryCommand;
      }

      return null;
    } catch (error: any) {
      console.error(`Error getting command ${commandId} from database:`, error);

      const memoryCommand = CommandStore.getCommand(commandId);
      if (memoryCommand) {
        CommandCache.cacheCommand(commandId, memoryCommand);
        return memoryCommand;
      }

      return null;
    }
  }

  /**
   * Obtiene todos los comandos de un usuario
   * 
   * @param userId ID del usuario
   * @returns Lista de comandos
   */
  async getUserCommands(userId: string): Promise<DbCommand[]> {
    try {
      // Obtener los comandos en memoria del usuario
      const memoryCommands = CommandStore.getUserCommands(userId);
      
      // También intentar obtener comandos de la base de datos si hubiera una función para ello
      // (actualmente no implementada en DatabaseAdapter)
      
      // Crear un mapa para almacenar únicamente comandos únicos
      const commandMap = new Map<string, DbCommand>();
      
      // Añadir los comandos en memoria
      memoryCommands.forEach((command: DbCommand) => {
        commandMap.set(command.id, command);
        
        // También guardar en caché para futuras consultas
        CommandCache.cacheCommand(command.id, command);
      });
      
      // Convertir el mapa a array
      return Array.from(commandMap.values());
    } catch (error) {
      console.error(`Error getting user commands:`, error);
      
      // Fallback a memoria
      return CommandStore.getUserCommands(userId);
    }
  }

  /**
   * Obtiene todos los comandos con un determinado estado
   * 
   * @param status Estado a filtrar
   * @returns Lista de comandos
   */
  async getCommandsByStatus(status: string): Promise<DbCommand[]> {
    // Filter commands by status
    return CommandStore.getCommandsByStatus(status);
  }

  /**
   * Elimina un comando
   * 
   * @param commandId ID del comando a eliminar
   * @returns true si se eliminó con éxito, false si no
   */
  async deleteCommand(commandId: string): Promise<boolean> {
    try {
      const dbId = CommandStore.getMappedId(commandId) || commandId;
      
      // Delete from database if it's a valid UUID
      if (DatabaseAdapter.isValidUUID(dbId)) {
        const { error } = await supabaseAdmin
          .from('commands')
          .delete()
          .eq('id', dbId);
        
        if (error) {
          throw error;
        }
      }
      
      // Delete from memory store as well (CommandStore emitirá el evento si está configurado)
      const exists = CommandStore.deleteCommand(commandId);
      
      // Si CommandStore no tiene eventEmitter configurado, emitimos el evento desde aquí
      if (exists && this.eventEmitter) {
        this.eventEmitter.emit('commandDeleted', { id: commandId });
      }
      
      return exists;
    } catch (error: any) {
      console.error(`Error deleting command ${commandId}:`, error);
      
      // Fallback to just memory store delete
      const exists = CommandStore.deleteCommand(commandId);
      
      // Si CommandStore no tiene eventEmitter configurado, emitimos el evento desde aquí
      if (exists && this.eventEmitter) {
        this.eventEmitter.emit('commandDeleted', { id: commandId });
      }
      
      return exists;
    }
  }
} 