/**
 * CommandCache - Servicio de caché para comandos durante el flujo de ejecución
 * 
 * Este servicio proporciona una caché en memoria para los comandos durante 
 * su ejecución, evitando múltiples accesos a la base de datos y asegurando
 * que propiedades como agent_background se mantengan a lo largo del flujo.
 */
import { DbCommand } from '../../models/types';
import { EventEmitter } from 'events';

// Caché principal para comandos completos
const commandCache: Map<string, DbCommand> = new Map();

// Mapa para traducir entre IDs temporales y UUIDs
const idMapping: Map<string, string> = new Map();

// Tiempo de vida de la caché en ms (10 minutos por defecto)
const CACHE_TTL = 10 * 60 * 1000;

// Marcas de tiempo para limpieza de caché
const cacheTimestamps: Map<string, number> = new Map();

// Event emitter singleton
let eventEmitter: EventEmitter | null = null;

export class CommandCache {
  /**
   * Guarda un comando completo en la caché
   */
  static cacheCommand(commandId: string, command: DbCommand): void {
    // Guardar el comando completo
    commandCache.set(commandId, command);
    
    // Registrar el timestamp para limpieza
    cacheTimestamps.set(commandId, Date.now());
    
    // Si el comando tiene metadata con dbUuid, establecer el mapeo bidireccional
    if (command.metadata?.dbUuid) {
      this.syncIds(commandId, command.metadata.dbUuid);
      
      // También guardar el comando con el UUID de la BD
      commandCache.set(command.metadata.dbUuid, command);
      cacheTimestamps.set(command.metadata.dbUuid, Date.now());
    }
    
    // Reducimos los logs para evitar spam, solo mostramos información esencial
    const hasBackground = command.agent_background !== undefined && command.agent_background !== null;
    const backgroundInfo = hasBackground && command.agent_background ? 
      `${command.agent_background.length} chars` : 
      'sin';
    
    // Log de información de modelo para depuración
    const modelInfo = command.model_id 
      ? `model_id: ${command.model_id}` 
      : (command.model ? `model: ${command.model}` : 'sin modelo');
    
    // Log simple con menos detalles
    console.log(`🧠 [CommandCache] Comando cacheado: ${commandId} (${backgroundInfo} agent_background, ${modelInfo})`);
  }

  /**
   * Obtiene un comando completo de la caché
   */
  static getCachedCommand(commandId: string): DbCommand | null {
    // Intentar obtener por el ID proporcionado
    let command = commandCache.get(commandId);
    
    if (!command) {
      // Intentar buscar por UUID mapeado
      const mappedId = this.getMappedId(commandId);
      if (mappedId && mappedId !== commandId) {
        command = commandCache.get(mappedId);
        
        // Si encontramos el comando por ID mapeado, guardarlo también con el ID original
        // para futuros accesos directos
        if (command) {
          commandCache.set(commandId, command);
          cacheTimestamps.set(commandId, Date.now());
        }
      }
    }
    
    if (command) {
      // Actualizar el timestamp para extender el TTL
      cacheTimestamps.set(commandId, Date.now());
      console.log(`🧠 [CommandCache] Acierto de caché para comando: ${commandId}`);
      return command;
    }
    
    console.log(`🧠 [CommandCache] Fallo de caché para comando: ${commandId}`);
    return null;
  }

  /**
   * Actualiza un comando en la caché
   */
  static updateCachedCommand(commandId: string, updates: Partial<DbCommand>): DbCommand | null {
    const command = this.getCachedCommand(commandId);
    
    if (!command) {
      console.log(`🧠 [CommandCache] No se puede actualizar, comando no encontrado: ${commandId}`);
      return null;
    }
    
    // Crear un nuevo objeto comando con las actualizaciones
    const updatedCommand: DbCommand = {
      ...command,
      ...updates,
      updated_at: new Date().toISOString()
    };
    
    // Mantener el agent_background si ya existía y no se proporciona en las actualizaciones
    if (command.agent_background && !updates.agent_background) {
      updatedCommand.agent_background = command.agent_background;
      // Eliminamos log redundante
    }
    
    // Asegurar que el model_id se preserve y se actualice si se actualiza model
    if (updates.model && !updates.model_id) {
      // Si se actualiza el modelo pero no el model_id, usamos el model como model_id también
      updatedCommand.model_id = updates.model;
      console.log(`🧠 [CommandCache] Actualización automática de model_id a partir de model: ${updates.model}`);
    } else if (command.model_id && !updates.model_id) {
      // Si no se actualiza el model_id, preservamos el existente
      updatedCommand.model_id = command.model_id;
    }
    
    // MODIFICACIÓN: Manejar específicamente los resultados para evitar duplicación
    if (command.results && !updates.results) {
      // Si no hay nuevos resultados, mantener los existentes
      updatedCommand.results = command.results;
    } else if (updates.results) {
      // Si hay nuevos resultados, usar esos directamente en lugar de combinarlos
      updatedCommand.results = updates.results;
      console.log(`🧠 [CommandCache] Actualización de resultados: ${updates.results.length} resultados en total`);
    }
    
    // Guardar el comando actualizado en ambos IDs si existe mapeo
    commandCache.set(commandId, updatedCommand);
    cacheTimestamps.set(commandId, Date.now());
    
    // Si hay un ID mapeado, actualizarlo también
    const mappedId = this.getMappedId(commandId);
    if (mappedId && mappedId !== commandId) {
      commandCache.set(mappedId, updatedCommand);
      cacheTimestamps.set(mappedId, Date.now());
    }
    
    // Emitir evento de actualización si hay eventEmitter
    if (eventEmitter) {
      eventEmitter.emit('commandCacheUpdated', updatedCommand);
    }
    
    return updatedCommand;
  }

  /**
   * Sincroniza los IDs entre el temporal y el UUID de la BD
   * Establece un mapeo bidireccional entre ambos
   */
  static syncIds(tempId: string, dbId: string): void {
    // Mapeo bidireccional
    idMapping.set(tempId, dbId);
    idMapping.set(dbId, dbId); // El UUID siempre mapea a sí mismo
    
    console.log(`🧠 [CommandCache] Sincronización de IDs: ${tempId} ⟷ ${dbId}`);
    
    // Si el comando existe en la caché con el ID temporal, duplicarlo con el ID de BD
    const cachedCommand = commandCache.get(tempId);
    if (cachedCommand) {
      commandCache.set(dbId, cachedCommand);
      cacheTimestamps.set(dbId, Date.now());
    }
    
    // Si existe con el ID de BD pero no con el temporal, duplicarlo
    const dbCachedCommand = commandCache.get(dbId);
    if (dbCachedCommand && !commandCache.has(tempId)) {
      commandCache.set(tempId, dbCachedCommand);
      cacheTimestamps.set(tempId, Date.now());
    }
  }

  /**
   * Establece un mapeo entre un ID temporal y un UUID
   * @deprecated Use syncIds instead for bidirectional mapping
   */
  static setIdMapping(temporaryId: string, uuid: string): void {
    this.syncIds(temporaryId, uuid);
  }

  /**
   * Obtiene el UUID mapeado para un ID
   */
  static getMappedId(commandId: string): string | undefined {
    return idMapping.get(commandId);
  }

  /**
   * Elimina un comando de la caché
   */
  static removeCachedCommand(commandId: string): boolean {
    const exists = commandCache.has(commandId);
    
    if (exists) {
      // Eliminar el comando por el ID proporcionado
      commandCache.delete(commandId);
      cacheTimestamps.delete(commandId);
      
      // Obtener y eliminar también el comando mapeado si existe
      const mappedId = this.getMappedId(commandId);
      if (mappedId && mappedId !== commandId) {
        commandCache.delete(mappedId);
        cacheTimestamps.delete(mappedId);
        console.log(`🧠 [CommandCache] Comando eliminado también por ID mapeado: ${mappedId}`);
      }
      
      console.log(`🧠 [CommandCache] Comando eliminado de caché: ${commandId}`);
      
      // Emitir evento si hay eventEmitter
      if (eventEmitter) {
        eventEmitter.emit('commandCacheRemoved', { id: commandId });
      }
    }
    
    return exists;
  }

  /**
   * Establece el agent_background para un comando
   */
  static setAgentBackground(commandId: string, agentBackground: string): boolean {
    const command = this.getCachedCommand(commandId);
    
    // Si el comando ya existe en caché
    if (command) {
      // Verificar si ya tiene el mismo agent_background para evitar operaciones redundantes
      if (command.agent_background === agentBackground) {
        // Si es el mismo, no hacemos nada y evitamos log
        return true;
      }
      
      // Actualizar el comando con el nuevo agent_background
      const updatedCommand: DbCommand = {
        ...command,
        agent_background: agentBackground,
        updated_at: new Date().toISOString()
      };
      
      // Actualizar en ambos IDs (original y mapeado)
      commandCache.set(commandId, updatedCommand);
      cacheTimestamps.set(commandId, Date.now());
      
      // Si hay un ID mapeado, actualizarlo también
      const mappedId = this.getMappedId(commandId);
      if (mappedId && mappedId !== commandId) {
        commandCache.set(mappedId, updatedCommand);
        cacheTimestamps.set(mappedId, Date.now());
      }
      
      // Log sencillo 
      console.log(`🧠 [CommandCache] agent_background actualizado (${agentBackground.length} caracteres) para: ${commandId}`);
      
      return true;
    } else {
      // Si el comando no existe, creamos uno básico con solo el agent_background
      console.log(`🧠 [CommandCache] Creando entrada básica para comando no encontrado: ${commandId}`);
      
      const basicCommand: DbCommand = {
        id: commandId,
        agent_background: agentBackground,
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      } as DbCommand;
      
      // Guardar en caché con el ID proporcionado
      commandCache.set(commandId, basicCommand);
      cacheTimestamps.set(commandId, Date.now());
      
      // Si hay un ID mapeado, guardarlo también
      const mappedId = this.getMappedId(commandId);
      if (mappedId && mappedId !== commandId) {
        commandCache.set(mappedId, basicCommand);
        cacheTimestamps.set(mappedId, Date.now());
      }
      
      return true;
    }
  }

  /**
   * Establece el emisor de eventos
   */
  static setEventEmitter(emitter: EventEmitter): void {
    eventEmitter = emitter;
    console.log(`🧠 [CommandCache] EventEmitter configurado`);
  }

  /**
   * Limpia entradas antiguas de la caché
   */
  static cleanupCache(): void {
    const now = Date.now();
    let entriesRemoved = 0;
    
    // Recorrer todos los timestamps usando Array.from para evitar problemas con el iterador
    Array.from(cacheTimestamps.entries()).forEach(([commandId, timestamp]) => {
      if (now - timestamp > CACHE_TTL) {
        CommandCache.removeCachedCommand(commandId);
        entriesRemoved++;
      }
    });
    
    if (entriesRemoved > 0) {
      console.log(`🧠 [CommandCache] Limpieza completada, ${entriesRemoved} entradas antiguas eliminadas`);
    }
  }

  /**
   * Obtiene la cantidad de comandos en caché
   */
  static getCacheSize(): number {
    return commandCache.size;
  }

  /**
   * Obtiene todos los comandos actualmente en caché (para diagnóstico)
   */
  static getAllCachedCommands(): Map<string, DbCommand> {
    return new Map(commandCache);
  }

  /**
   * Obtiene todos los mapeos de IDs (para diagnóstico)
   */
  static getAllIdMappings(): Map<string, string> {
    return new Map(idMapping);
  }

  /**
   * Limpia toda la caché (para pruebas)
   */
  static clearAll(): void {
    commandCache.clear();
    idMapping.clear();
    cacheTimestamps.clear();
    console.log(`🧠 [CommandCache] Caché limpiada completamente`);
  }
}

// Iniciar limpieza automática cada 5 minutos
setInterval(() => {
  CommandCache.cleanupCache();
}, 5 * 60 * 1000); 