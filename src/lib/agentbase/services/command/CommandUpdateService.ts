/**
 * CommandUpdateService - Servicio para actualizar comandos
 */
import { DbCommand } from '../../models/types';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import { CommandStore } from './CommandStore';
import { EventEmitter } from 'events';
import { CommandCache } from './CommandCache';

export class CommandUpdateService {
  private eventEmitter: EventEmitter;
  
  constructor(eventEmitter: EventEmitter) {
    this.eventEmitter = eventEmitter;
  }
  
  /**
   * Actualiza un comando con los campos proporcionados
   * 
   * @param commandId ID del comando a actualizar
   * @param updates Campos a actualizar
   * @returns Comando actualizado
   * @throws Error si el comando no se encuentra
   */
  async updateCommand(
    commandId: string, 
    updates: Partial<Omit<DbCommand, 'id' | 'created_at' | 'updated_at'>>
  ): Promise<DbCommand> {
    try {
      // Simplificamos los logs para reducir spam
      if (updates.agent_background) {
        // MODIFICACIÓN: Verificar si realmente debemos actualizar el agent_background
        // Solo se debe actualizar durante la inicialización del agente, no al actualizar resultados
        const isFromInitialization = updates.agent_background && 
                                   (!updates.results || updates.results.length === 0);
        
        if (isFromInitialization) {
          console.log(`[CommandUpdateService] Actualizando comando ${commandId} con agent_background (${updates.agent_background.length} caracteres)`);
        } else {
          // Si hay resultados, NO actualizar el agent_background
          console.log(`[CommandUpdateService] ⚠️ Recibida solicitud para actualizar agent_background junto con resultados. Preservando agent_background existente.`);
          // Recuperar el agent_background existente y eliminarlo de las actualizaciones
          const existingCommand = CommandCache.getCachedCommand(commandId);
          if (existingCommand && existingCommand.agent_background) {
            console.log(`[CommandUpdateService] ✅ Preservando agent_background existente (${existingCommand.agent_background.length} caracteres)`);
            // Eliminar agent_background de las actualizaciones para evitar sobrescribirlo
            const { agent_background, ...updatesWithoutBackground } = updates;
            updates = updatesWithoutBackground;
          } else {
            console.log(`[CommandUpdateService] ⚠️ No se encontró agent_background existente en caché para preservar`);
          }
        }
      } else {
        console.log(`[CommandUpdateService] Actualizando comando ${commandId} (sin cambios en agent_background)`);
      }
      
      // 1. Primero intentar obtener el comando de la caché
      let command = CommandCache.getCachedCommand(commandId);
      
      // 2. Si no está en caché, intentar obtenerlo del CommandStore
      if (!command) {
        const storeCommand = CommandStore.getCommand(commandId);
        if (storeCommand) {
          command = storeCommand;
        }
      }
      
      // 3. Obtener el UUID de la base de datos si existe
      const dbId = CommandStore.getMappedId(commandId) || (command?.metadata?.dbUuid);
      
      // Si tenemos acceso a la caché, actualizar primero ahí para mantener coherencia
      if (command) {
        // Verificar si el comando actual tiene agent_background que debemos preservar
        if (command.agent_background && !updates.agent_background) {
          // Preservar agent_background silenciosamente sin spam de logs
          updates = {
            ...updates,
            agent_background: command.agent_background
          };
        }
        
        // MODIFICACIÓN: Validar explícitamente que no estemos sobrescribiendo resultados existentes 
        // al actualizar el agent_background
        if (command.results && command.results.length > 0 && updates.agent_background && !updates.results) {
          console.log(`[CommandUpdateService] ⚠️ Se detectó actualización de agent_background que podría sobrescribir resultados`);
          // Asegurar que los resultados se preserven
          updates.results = command.results;
        }
        
        // Actualizar en la caché
        const cachedCommand = CommandCache.updateCachedCommand(commandId, updates);
        if (cachedCommand) {
          // Log simple
          console.log(`[CommandUpdateService] Comando actualizado en caché: ${commandId}`);
        }
      }
      
      // 4. Intentar actualizar en la base de datos si hay un UUID válido
      let dbUpdated = false;
      if (dbId && DatabaseAdapter.isValidUUID(dbId)) {
        console.log(`[CommandUpdateService] ID ${dbId} es un UUID válido, enviando actualización a BD`);
        
        // Actualizar el comando en la base de datos
        try {
          // Necesitamos manejar las conversiones de tipos para la base de datos
          const dbUpdates: any = { ...updates };
          
          // Convertir 'status' a formato de BD si es necesario
          if (dbUpdates.status) {
            // Verificar si es un cambio de estado crítico
            if (dbUpdates.status === 'failed' || dbUpdates.status === 'completed') {
              console.log(`⚠️ [CommandUpdateService] ACTUALIZACIÓN CRÍTICA: Cambio de estado para ${dbId} a ${dbUpdates.status}`);
            }
          }
          
          // Verificar si necesitamos preservar el agent_background
          if (command?.agent_background && !dbUpdates.agent_background) {
            console.log(`[CommandUpdateService] Preservando agent_background existente`);
            dbUpdates.agent_background = command.agent_background;
          }
          
          // Si solo se está actualizando el status, preservar las funciones también
          if (dbUpdates.status && !dbUpdates.functions && command?.functions && command.functions.length > 0) {
            console.log(`[CommandUpdateService] 🔍 Preservando ${command.functions.length} funciones al actualizar solo status a ${dbUpdates.status}`);
            
            // Verificar estados de funciones a preservar
            const failedFunctions = command.functions.filter(f => f.status === 'failed').length;
            const completedFunctions = command.functions.filter(f => f.status === 'completed').length;
            const requiredFunctions = command.functions.filter(f => f.status === 'required').length;
            
            console.log(`[CommandUpdateService] 📊 Funciones preservadas: ${completedFunctions} completed, ${failedFunctions} failed, ${requiredFunctions} required`);
            
            // Añadir las funciones a la actualización
            dbUpdates.functions = command.functions;
          }
          
          // Nunca restringir qué se guarda - actualizar directamente lo enviado
          console.log(`📝 [CommandUpdateService] Enviando actualizaciones a BD: ${Object.keys(dbUpdates).join(', ')}`);
          if (dbUpdates.functions) {
            console.log(`📊 [CommandUpdateService] Actualizando ${dbUpdates.functions.length} funciones en BD`);
          }
          
          // Enviar todas las actualizaciones a la base de datos directamente
          await DatabaseAdapter.updateCommand(dbId, dbUpdates);
          
          console.log(`✅ [CommandUpdateService] Comando actualizado exitosamente en BD: ${dbId}`);
          dbUpdated = true;
          
          // Obtener el comando actualizado de la base de datos (solo si es necesario)
          // Esto reduce las consultas innecesarias a la BD
          if (updates.agent_background || updates.status === 'completed' || updates.status === 'failed') {
            const updatedDbCommand = await DatabaseAdapter.getCommandById(dbId);
            if (updatedDbCommand) {
              // Convertir a formato de la aplicación
              const resultCommand: DbCommand = {
                ...updatedDbCommand,
                id: commandId // Mantener el ID original
              };
              
              // Guardar en la caché y CommandStore
              CommandCache.cacheCommand(commandId, resultCommand);
              CommandStore.setCommand(commandId, resultCommand);
              
              // Verificar si hay funciones actualizadas
              if (resultCommand.functions && resultCommand.functions.length > 0) {
                const failedFunctions = resultCommand.functions.filter(f => f.status === 'failed').length;
                const completedFunctions = resultCommand.functions.filter(f => f.status === 'completed').length;
                const requiredFunctions = resultCommand.functions.filter(f => f.status === 'required').length;
                
                console.log(`[CommandUpdateService] Estado de funciones en comando actualizado: ${completedFunctions} completed, ${failedFunctions} failed, ${requiredFunctions} required de ${resultCommand.functions.length} totales`);
              }
              
              // Emitir evento de actualización
              this.eventEmitter.emit('commandUpdated', resultCommand);
              
              return resultCommand;
            }
          }
        } catch (dbError) {
          console.error(`[CommandUpdateService] Error al actualizar en BD:`, dbError);
          // Continuar con actualización en memoria si falla la BD
        }
      }
      
      // 5. Si no hay UUID válido o falló la actualización en BD, actualizar solo en memoria
      
      // Obtener el comando actual (o crear uno nuevo si no existe)
      if (!command) {
        const storeCommand = CommandStore.getCommand(commandId);
        if (storeCommand) {
          command = storeCommand;
        } else {
          throw new Error(`Command not found: ${commandId}`);
        }
      }
      
      // Update command fields (preserving any existing metadata)
      const metadata = command.metadata || {};
      const updatedCommand: DbCommand = {
        ...command,
        ...updates,
        updated_at: new Date().toISOString(),
        metadata: {
          ...metadata,
          lastUpdated: new Date().toISOString()
        }
      };
      
      // Preservar agent_background si no está en las actualizaciones
      if (command.agent_background && !updates.agent_background) {
        updatedCommand.agent_background = command.agent_background;
      }
      
      // Store updated command
      CommandStore.setCommand(commandId, updatedCommand);
      
      // Solo actualizamos la caché si no lo hicimos antes
      if (!dbUpdated) {
        CommandCache.cacheCommand(commandId, updatedCommand);
      }
      
      // Emit command updated event (include any database ID if available)
      const eventDbId = dbId || (metadata && metadata.dbUuid) || commandId;
      this.eventEmitter.emit('commandUpdated', {
        ...updatedCommand,
        _dbId: eventDbId  // Include possible database ID
      });
      
      return updatedCommand;
    } catch (error: any) {
      console.error(`Error updating command ${commandId}:`, error);
      throw error;
    }
  }

  /**
   * Actualiza el orden de ejecución de un comando
   * 
   * @param commandId ID del comando
   * @param executionOrder Nuevo orden de ejecución
   * @returns true si la actualización se realizó con éxito, false si no
   */
  async updateExecutionOrder(commandId: string, executionOrder: string[]): Promise<boolean> {
    try {
      // Update execution order in database
      const dbId = CommandStore.getMappedId(commandId) || commandId;
      if (DatabaseAdapter.isValidUUID(dbId)) {
        await DatabaseAdapter.updateCommand(dbId, { execution_order: executionOrder });
      }
      
      // Also update in memory
      const command = CommandStore.getCommand(commandId);
      if (command) {
        const updatedCommand = {
          ...command,
          execution_order: executionOrder,
          updated_at: new Date().toISOString()
        };
        CommandStore.setCommand(commandId, updatedCommand);
      }
      
      return true;
    } catch (error: any) {
      console.error(`Error updating execution order for command ${commandId}:`, error);
      
      // Fallback to memory update only
      const command = CommandStore.getCommand(commandId);
      
      if (!command) {
        return false;
      }
      
      // Update execution order
      const updatedCommand = {
        ...command,
        execution_order: executionOrder,
        updated_at: new Date().toISOString()
      };
      
      // Store updated command
      CommandStore.setCommand(commandId, updatedCommand);
      
      return true;
    }
  }

  /**
   * Actualiza la prioridad de un comando
   * 
   * @param commandId ID del comando
   * @param priority Nueva prioridad
   * @returns true si la actualización se realizó con éxito, false si no
   */
  async updatePriority(commandId: string, priority: number): Promise<boolean> {
    const command = CommandStore.getCommand(commandId);
    
    if (!command) {
      return false;
    }
    
    // Update priority
    const updatedCommand = {
      ...command,
      priority,
      updated_at: new Date().toISOString()
    };
    
    // Store updated command
    CommandStore.setCommand(commandId, updatedCommand);
    
    return true;
  }

  /**
   * Calcula la duración de un comando
   * 
   * @param startTime Tiempo de inicio
   * @returns Duración en milisegundos
   */
  calculateDuration(startTime: string): number {
    const start = new Date(startTime).getTime();
    const end = new Date().getTime();
    return end - start;
  }
} 