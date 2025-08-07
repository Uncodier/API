/**
 * CommandQueryService - Servicio para consultas de comandos
 */
import { DbCommand } from '../../models/types';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import { CommandStore } from './CommandStore';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { EventEmitter } from 'events';
import { CommandCache } from './CommandCache';

export class CommandQueryService {
  private eventEmitter: EventEmitter | null = null;
  
  constructor(eventEmitter?: EventEmitter) {
    this.eventEmitter = eventEmitter || null;
  }
  
  setEventEmitter(eventEmitter: EventEmitter): void {
    this.eventEmitter = eventEmitter;
  }
  
  /**
   * Obtiene un comando por su ID
   * 
   * @param commandId ID del comando
   * @returns Comando encontrado o null si no existe
   */
  async getCommandById(commandId: string): Promise<DbCommand | null> {
    try {
      // 1. Primero intentar obtener de la caché para el mismo hilo de ejecución
      const cachedCommand = CommandCache.getCachedCommand(commandId);
      
      // 2. Si no está en caché, o si está en caché pero está en estado 'pending', 
      // verificar también en la base de datos para tener la información más actualizada
      if (!cachedCommand || cachedCommand.status === 'pending') {
        // Si no está en caché, verificar si necesitamos traducir el ID
        const dbId = CommandStore.getMappedId(commandId) || commandId;
        
        // Intentar obtener el comando de la base de datos
        const command = await DatabaseAdapter.getCommandById(dbId);
        
        if (command) {
          // Si encontramos el comando, necesitamos devolverlo con el ID solicitado
          const resultCommand = { ...command };
          if (commandId !== dbId) {
            resultCommand.id = commandId; // Usar el ID solicitado (formato antiguo)
          }
          
          // CRUCIAL: Si hay comando en caché con agent_background, preservarlo
          if (cachedCommand?.agent_background && !resultCommand.agent_background) {
            console.log(`🔄 [CommandQueryService] Preservando agent_background desde caché (${cachedCommand.agent_background.length} caracteres)`);
            resultCommand.agent_background = cachedCommand.agent_background;
          }
          
          // Update memory store with latest data
          CommandStore.setCommand(commandId, resultCommand);
          
          // Guardar en caché para futuras consultas en este flujo
          CommandCache.cacheCommand(commandId, resultCommand);
          
          return resultCommand;
        }
        
        // Si tenemos un comando en caché, devolver ese
        if (cachedCommand) {
          return cachedCommand;
        }
        
        // 4. If not found in database or cache, try memory store
        const memoryCommand = CommandStore.getCommand(commandId);
        if (memoryCommand) {
          // También guardar en caché para futuras consultas
          CommandCache.cacheCommand(commandId, memoryCommand);
          return memoryCommand;
        }
        
        return null;
      } else {
        // Si el comando está en caché y no está en estado 'pending', podemos devolver la versión en caché
        return cachedCommand;
      }
    } catch (error: any) {
      console.error(`Error getting command ${commandId} from database:`, error);
      
      // Fallback to in-memory storage
      const memoryCommand = CommandStore.getCommand(commandId);
      if (memoryCommand) {
        // También guardar en caché para futuras consultas
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