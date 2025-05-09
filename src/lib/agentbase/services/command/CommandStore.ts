/**
 * CommandStore - Servicio para almacenamiento en memoria de comandos
 */
import { DbCommand } from '../../models/types';
import { EventEmitter } from 'events';

// Mapa para traducir entre IDs de formato antiguo y UUIDs
const idTranslationMap: Map<string, string> = new Map();

// In-memory storage for commands (fallback when DB is not available)
const commandsStore: Map<string, DbCommand> = new Map();

// Event emitter singleton
let eventEmitter: EventEmitter | null = null;

export class CommandStore {
  /**
   * Guarda un comando en el almacén en memoria
   */
  static setCommand(commandId: string, command: DbCommand): void {
    commandsStore.set(commandId, command);
  }

  /**
   * Obtiene un comando del almacén en memoria
   */
  static getCommand(commandId: string): DbCommand | undefined {
    return commandsStore.get(commandId);
  }

  /**
   * Elimina un comando del almacén en memoria
   */
  static deleteCommand(commandId: string, emitEvent: boolean = true): boolean {
    const exists = commandsStore.has(commandId);
    
    if (exists) {
      commandsStore.delete(commandId);
      
      // Emit command deleted event if requested and eventEmitter is set
      if (emitEvent && eventEmitter) {
        eventEmitter.emit('commandDeleted', { id: commandId });
      }
    }
    
    return exists;
  }

  /**
   * Establece un mapeo entre un ID de formato antiguo y un UUID
   */
  static setIdMapping(legacyId: string, uuid: string): void {
    idTranslationMap.set(legacyId, uuid);
    // También guardar la relación inversa para facilitar las búsquedas
    idTranslationMap.set(uuid, uuid);
  }

  /**
   * Obtiene el UUID correspondiente a un ID (sea legacy o UUID)
   */
  static getMappedId(commandId: string): string | undefined {
    return idTranslationMap.get(commandId);
  }

  /**
   * Obtiene todos los comandos que cumplen con el predicado
   */
  static getCommandsByPredicate(predicate: (command: DbCommand) => boolean): DbCommand[] {
    return Array.from(commandsStore.values()).filter(predicate);
  }

  /**
   * Obtiene todos los comandos de un usuario
   */
  static getUserCommands(userId: string): DbCommand[] {
    return this.getCommandsByPredicate(command => command.user_id === userId);
  }

  /**
   * Obtiene todos los comandos con un determinado estado
   */
  static getCommandsByStatus(status: string): DbCommand[] {
    return this.getCommandsByPredicate(command => command.status === status);
  }

  /**
   * Elimina todos los comandos (para pruebas)
   */
  static clearAll(): void {
    commandsStore.clear();
    idTranslationMap.clear();
  }

  /**
   * Establece el emisor de eventos para notificaciones
   */
  static setEventEmitter(emitter: EventEmitter): void {
    eventEmitter = emitter;
  }

  /**
   * Obtiene la cantidad de comandos almacenados
   */
  static getCommandCount(): number {
    return commandsStore.size;
  }

  /**
   * Verifica si un comando existe
   */
  static hasCommand(commandId: string): boolean {
    return commandsStore.has(commandId);
  }
} 