/**
 * Servicio de actualización avanzada de comandos
 */

import {
  DbCommand as AgentbaseDbCommand
} from '../models/types';

import {
  updateCommand as dbUpdateCommand,
  getCommandById as dbGetCommandById
} from '@/lib/database/command-db';

import { CommandConverter } from './CommandConverter';
import { StatusConverter } from './StatusConverter';
import { isValidUUID } from '../utils/UuidUtils';
import { extractConversationId } from '../utils/DataFormatUtils';
import { ensureTargetContentExists } from '../utils/DataFormatUtils';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CommandService } from './CommandService';
import { DatabaseAdapter } from '../adapters/DatabaseAdapter';
import { CommandCache } from '../services/command/CommandCache';

/**
 * Clase para manejo avanzado de actualizaciones de comandos
 */
export class CommandUpdateService {
  /**
   * Actualiza un comando con manejo de errores y reintentos
   */
  static async updateCommand(
    commandId: string,
    updates: Partial<Omit<AgentbaseDbCommand, 'id' | 'created_at' | 'updated_at'>>
  ): Promise<AgentbaseDbCommand> {
    console.log(`[CommandUpdateService] Actualizando comando ${commandId} con:`, 
      Object.keys(updates).map(k => `${k}=${k === 'agent_background' 
        ? `(${(updates as any)[k]?.length || 0} chars)` 
        : (k === 'results' ? `(${(updates as any)[k]?.length || 0} items)` : 'value')}`
      ).join(', '));
    
    // Verificar si hay actualizaciones
    if (!updates || Object.keys(updates).length === 0) {
      console.warn(`[CommandUpdateService] No hay campos para actualizar en el comando ${commandId}`);
      
      // Intentar obtener el comando existente
      const existingCommand = await CommandService.getCommandById(commandId);
      if (existingCommand) {
        console.log(`[CommandUpdateService] Devolviendo comando existente sin cambios`);
        return existingCommand;
      } else {
        throw new Error(`No updates provided and command not found: ${commandId}`);
      }
    }
    
    // Primero intentamos obtener el comando existente de la caché
    const cachedCommand = CommandCache.getCachedCommand(commandId);
    
    // Convertir las actualizaciones a formato de base de datos
    const dbUpdates: any = {};
    
    // MODIFICACIÓN: Preservar agent_background existente si no está en las actualizaciones
    // o si hay una actualización simultánea con resultados
    const hasResults = updates.results !== undefined;
    const hasAgentBackground = updates.agent_background !== undefined;
    
    // Si hay un comando en caché con agent_background y estamos actualizando resultados
    if (cachedCommand?.agent_background && hasResults) {
      console.log(`[CommandUpdateService] ℹ️ Se preservará agent_background existente (${cachedCommand.agent_background.length} caracteres)`);
      
      // Preservar agent_background existente en las actualizaciones
      if (!hasAgentBackground) {
        updates.agent_background = cachedCommand.agent_background;
      }
    }
    
    // Ahora procesamos las actualizaciones
    if (updates.status !== undefined) {
      const convertedStatus = StatusConverter.toDbFormat(updates.status);
      console.log(`[CommandUpdateService] Actualizando status de '${updates.status}' a formato DB: '${convertedStatus}'`);
      dbUpdates.status = convertedStatus;
      
      // Prioridad alta si es una actualización de status
      console.log(`⚠️ [CommandUpdateService] ACTUALIZACIÓN CRÍTICA: Cambio de estado para ${commandId} a ${convertedStatus}`);
    }
    
    if (updates.task !== undefined) {
      console.log(`[CommandUpdateService] Actualizando task: ${updates.task.substring(0, 50)}...`);
      dbUpdates.task = updates.task;
    }
    
    if (updates.description !== undefined) {
      console.log(`[CommandUpdateService] Actualizando description`);
      dbUpdates.description = updates.description;
    }
    
    // Procesar los targets para asegurar que siempre tengan content, aunque sea null
    if (updates.targets !== undefined) {
      console.log(`[CommandUpdateService] Procesando targets para comando ${commandId}`);
      const processedTargets = ensureTargetContentExists(updates.targets);
      dbUpdates.targets = processedTargets;
      console.log(`[CommandUpdateService] Targets actualizados:`, 
        JSON.stringify(processedTargets, null, 2).substring(0, 300) + '...');
    }
    
    if (updates.tools !== undefined) {
      console.log(`[CommandUpdateService] Actualizando ${updates.tools.length} tools`);
      dbUpdates.tools = updates.tools;
    }
    
    // Nueva sección para actualizar functions
    if (updates.functions !== undefined) {
      console.log(`[CommandUpdateService] Actualizando ${updates.functions.length} functions`);
      dbUpdates.functions = updates.functions;
    }
    
    // Procesar el contexto de conversación
    if (updates.context !== undefined) {
      console.log(`[CommandUpdateService] Actualizando context`);
      dbUpdates.context = updates.context;
      
      // Extraer el conversationId si existe (solo para logging)
      const conversationId = extractConversationId(updates.context);
      if (conversationId) {
        console.log(`[CommandUpdateService] Conversación ID encontrado en actualización: ${conversationId}`);
      }
    }
    
    if (updates.supervisor !== undefined) {
      console.log(`[CommandUpdateService] Actualizando supervisor`);
      dbUpdates.supervisor = updates.supervisor;
    }
    
    if (updates.model !== undefined) {
      console.log(`[CommandUpdateService] Actualizando model: ${updates.model}`);
      dbUpdates.model = updates.model;
    }
    
    // Procesamiento especial para asegurar correcta actualización de resultados
    if (updates.results !== undefined) {
      console.log(`[CommandUpdateService] Actualizando ${updates.results?.length || 0} resultados para comando ${commandId}`);
      
      // Verificar que results sea un array
      if (!Array.isArray(updates.results)) {
        console.warn(`[CommandUpdateService] results no es un array, convirtiendo:`, updates.results);
        dbUpdates.results = updates.results ? [updates.results] : [];
      } else {
        // Verificar cada resultado para asegurar que tenga una estructura válida
        const validResults = updates.results.filter(result => {
          // ACTUALIZACIÓN: Aceptar cualquier objeto como válido, respetando completamente
          // la estructura original de los targets
          const isValid = result && typeof result === 'object';
          if (!isValid) {
            console.warn(`[CommandUpdateService] Resultado inválido ignorado:`, result);
          }
          return isValid;
        });
        
        // Diagnóstico de resultados
        if (validResults.length === 0 && updates.results.length > 0) {
          console.warn(`[CommandUpdateService] ADVERTENCIA: Todos los resultados fueron considerados inválidos.`);
          console.log(`[CommandUpdateService] Primer resultado original:`, JSON.stringify(updates.results[0]));
        }
        
        if (validResults.length > 0) {
          console.log(`[CommandUpdateService] Ejemplo de resultado válido:`, JSON.stringify(validResults[0]).substring(0, 200) + '...');
        }
        
        console.log(`[CommandUpdateService] ${validResults.length} resultados válidos encontrados de ${updates.results.length} originales`);
        
        // CORRECCIÓN: Asignar los resultados válidos a dbUpdates.results
        dbUpdates.results = validResults;
      }
    }
    
    // Añadir tokens si están definidos
    if (updates.input_tokens !== undefined) {
      console.log(`[CommandUpdateService] Actualizando input_tokens: ${updates.input_tokens}`);
      dbUpdates.input_tokens = updates.input_tokens;
      
      // Intenta forzar como número para evitar problemas de tipado
      if (typeof dbUpdates.input_tokens !== 'number') {
        const numericValue = Number(dbUpdates.input_tokens);
        if (!isNaN(numericValue)) {
          console.log(`[CommandUpdateService] Convirtiendo input_tokens a número: ${dbUpdates.input_tokens} -> ${numericValue}`);
          dbUpdates.input_tokens = numericValue;
        }
      }
    }
    
    if (updates.output_tokens !== undefined) {
      console.log(`[CommandUpdateService] Actualizando output_tokens: ${updates.output_tokens}`);
      dbUpdates.output_tokens = updates.output_tokens;
      
      // Intenta forzar como número para evitar problemas de tipado
      if (typeof dbUpdates.output_tokens !== 'number') {
        const numericValue = Number(dbUpdates.output_tokens);
        if (!isNaN(numericValue)) {
          console.log(`[CommandUpdateService] Convirtiendo output_tokens a número: ${dbUpdates.output_tokens} -> ${numericValue}`);
          dbUpdates.output_tokens = numericValue;
        }
      }
    }
    
    // Manejar el agent_id específicamente
    if (updates.agent_id !== undefined) {
      console.log(`[CommandUpdateService] Actualizando agent_id: ${updates.agent_id}`);
      dbUpdates.agent_id = updates.agent_id;
    }
    
    // Manejar específicamente el agent_background
    if (updates.agent_background !== undefined) {
      console.log(`[CommandUpdateService] Actualizando agent_background: ${updates.agent_background?.substring(0, 100)}...`);
      dbUpdates.agent_background = updates.agent_background;
    } else if (cachedCommand?.agent_background) {
      // Si no hay agent_background en las actualizaciones pero existe en la caché, preservarlo
      console.log(`[CommandUpdateService] Preservando agent_background existente`);
      dbUpdates.agent_background = cachedCommand.agent_background;
    }
    
    // Primero actualizamos en la caché
    if (cachedCommand) {
      // Actualizar en caché incluyendo el comando completo ya existente
      const updatedCachedCommand = {
        ...cachedCommand,
        ...updates,
        updated_at: new Date().toISOString()
      };
      
      // Si no hay agent_background en las actualizaciones pero existe en la caché, preservarlo
      if (!updates.agent_background && cachedCommand.agent_background) {
        updatedCachedCommand.agent_background = cachedCommand.agent_background;
      }
      
      // Actualizar en la caché
      CommandCache.cacheCommand(commandId, updatedCachedCommand);
      console.log(`[CommandUpdateService] ✅ Comando actualizado en caché`);
    }
    
    // Realizar la actualización en BD
    try {
      // Solo actualizar en la BD si es un UUID válido
      if (isValidUUID(commandId)) {
        console.log(`[CommandUpdateService] ID ${commandId} es un UUID válido, enviando actualización a BD`);
        
        // Procesar la actualización de estado primero si existe, separada del resto
        if (dbUpdates.status) {
          try {
            console.log(`🚨 [CommandUpdateService] Actualizando SOLO STATUS a ${dbUpdates.status} para ${commandId}`);
            // Actualizar el estado directamente con Supabase para mayor fiabilidad
            const { data: statusData, error: statusError } = await supabaseAdmin
              .from('commands')
              .update({ status: dbUpdates.status })
              .eq('id', commandId)
              .select();
            
            if (statusError) {
              console.error(`❌ [CommandUpdateService] Error al actualizar estado con Supabase:`, statusError);
            } else {
              console.log(`✅ [CommandUpdateService] Estado actualizado exitosamente para ${commandId} a ${dbUpdates.status}`);
              
              // Si solo estamos actualizando el estado, podemos devolver aquí
              if (Object.keys(dbUpdates).length === 1) {
                if (statusData && statusData.length > 0) {
                  // Convertir y guardar en caché
                  const formattedCommand = CommandConverter.toAgentbaseFormat(statusData[0]);
                  
                  // Preservar agent_background existente si ya existe en la caché
                  if (cachedCommand?.agent_background && !formattedCommand.agent_background) {
                    formattedCommand.agent_background = cachedCommand.agent_background;
                  }
                  
                  // Actualizar en la caché con el comando completo
                  CommandCache.cacheCommand(commandId, formattedCommand);
                  return formattedCommand;
                }
              }
            }
          } catch (statusUpdateError) {
            console.error(`❌ [CommandUpdateService] Error crítico al actualizar estado:`, statusUpdateError);
            // Continuar con la actualización normal si la específica de estado falla
          }
        }
        
        // Buscar datos completos del comando desde la caché o la base de datos
        let existingCommand = cachedCommand;
        if (!existingCommand) {
          existingCommand = await CommandService.getCommandById(commandId);
        }
        
        if (!existingCommand) {
          console.error(`[CommandUpdateService] Error: El comando ${commandId} no existe en la base de datos ni en caché`);
          throw new Error(`Command not found: ${commandId}`);
        }
        
        console.log(`[CommandUpdateService] Comando existente encontrado, estado actual: ${existingCommand.status}`);
        
        console.log(`[CommandUpdateService] Enviando actualizaciones a BD:`, JSON.stringify(dbUpdates, null, 2).substring(0, 300) + '...');
        
        // Realizar la actualización
        const dbCommand = await dbUpdateCommand(commandId, dbUpdates);
        console.log(`[CommandUpdateService] Comando ${commandId} actualizado exitosamente, nuevo estado: ${dbCommand.status}`);
        
        // Verificar que se actualizaron los resultados si estaban presentes en la actualización
        if (updates.results !== undefined && updates.results.length > 0 && 
            (!dbCommand.results || dbCommand.results.length === 0)) {
          console.warn(`[CommandUpdateService] ADVERTENCIA: Los resultados no se actualizaron correctamente en el comando ${commandId}`);
          console.log(`[CommandUpdateService] Realizando una segunda actualización solo para resultados...`);
          
          try {
            // Usar updates.results directamente
            if (!updates.results || !Array.isArray(updates.results)) {
              console.error(`[CommandUpdateService] No hay resultados válidos para reintento de actualización`);
            } else {
              // Verificación adicional de la estructura de los resultados
              console.log(`[CommandUpdateService] Verificando estructura de ${updates.results.length} resultados`);
              const allValid = updates.results.every(r => r && typeof r === 'object');
              if (!allValid) {
                console.error(`[CommandUpdateService] Hay resultados con estructura inválida, no se realizará el segundo intento`);
              } else {
                // Hacer una actualización específica solo para resultados con estructura simplificada
                const simplifiedResults = updates.results.map((r: any) => {
                  try {
                    // Mantener solo los campos esenciales para reducir complejidad
                    const simplifiedResult = {
                      type: r.type || 'text',
                      content: r.content
                    };
                    
                    // Si content no es un string, convertirlo a string
                    if (simplifiedResult.content && typeof simplifiedResult.content !== 'string') {
                      simplifiedResult.content = JSON.stringify(simplifiedResult.content);
                    }
                    
                    return simplifiedResult;
                  } catch (err) {
                    console.error(`[CommandUpdateService] Error simplificando resultado:`, err);
                    return { type: 'text', content: 'Error al procesar resultado' };
                  }
                });
                
                console.log(`[CommandUpdateService] Intentando actualizar con resultados simplificados: [${simplifiedResults.length} elementos]`);
                
                // Intentar primero con Supabase directamente para diagnóstico
                console.log(`[CommandUpdateService] Actualizando resultados directamente con Supabase...`);
                const { data, error } = await supabaseAdmin
                  .from('commands')
                  .update({ results: simplifiedResults })
                  .eq('id', commandId)
                  .select();
                
                if (error) {
                  console.error(`[CommandUpdateService] Error con Supabase:`, error);
                  
                  // Intentar con la función regular de actualización
                  const retryUpdate = await dbUpdateCommand(commandId, { results: simplifiedResults });
                  console.log(`[CommandUpdateService] Segunda actualización completada con función normal, resultados: ${retryUpdate.results?.length || 0}`);
                  
                  // Convertir y guardar en caché
                  const formattedRetryCommand = CommandConverter.toAgentbaseFormat(retryUpdate);
                  
                  // Preservar agent_background existente si ya existe en la caché
                  if (existingCommand.agent_background && !formattedRetryCommand.agent_background) {
                    formattedRetryCommand.agent_background = existingCommand.agent_background;
                  }
                  
                  // Actualizar en la caché
                  CommandCache.cacheCommand(commandId, formattedRetryCommand);
                  return formattedRetryCommand;
                } else {
                  console.log(`[CommandUpdateService] Actualización directa con Supabase exitosa, filas: ${data?.length || 0}`);
                  
                  if (data && data.length > 0) {
                    // Convertir y guardar en caché
                    const formattedDataCommand = CommandConverter.toAgentbaseFormat(data[0]);
                    
                    // Preservar agent_background existente si ya existe en la caché
                    if (existingCommand.agent_background && !formattedDataCommand.agent_background) {
                      formattedDataCommand.agent_background = existingCommand.agent_background;
                    }
                    
                    // Actualizar en la caché
                    CommandCache.cacheCommand(commandId, formattedDataCommand);
                    return formattedDataCommand;
                  }
                }
              }
            }
          } catch (retryError: any) {
            console.error(`[CommandUpdateService] Error en segunda actualización: ${retryError.message}`);
            // Continuar con la versión original si falla la segunda actualización
          }
        }
        
        // Convertir comando actualizado
        const formattedCommand = CommandConverter.toAgentbaseFormat(dbCommand);
        
        // Preservar agent_background existente si ya existe en la caché y no está en la respuesta
        if (existingCommand.agent_background && !formattedCommand.agent_background) {
          formattedCommand.agent_background = existingCommand.agent_background;
        }
        
        // Actualizar en la caché con el comando completo
        CommandCache.cacheCommand(commandId, formattedCommand);
        
        console.log(`[CommandUpdateService] Comando formateado para devolver:`, JSON.stringify(formattedCommand, null, 2).substring(0, 300) + '...');
        return formattedCommand;
      } else {
        console.log(`[CommandUpdateService] ID ${commandId} no es un UUID válido, actualizando solo en caché`);
        
        // Buscar si hay un comando existente en memoria o caché
        let existingCommand = cachedCommand;
        if (!existingCommand) {
          existingCommand = await CommandService.getCommandById(commandId);
        }
        
        if (existingCommand) {
          console.log(`[CommandUpdateService] Comando existente encontrado, actualizando localmente`);
          
          // Crear un comando actualizado combinando el existente con las actualizaciones
          const updatedCommand = {
            ...existingCommand,
            ...updates,
            updated_at: new Date().toISOString()
          };
          
          // Preservar agent_background si no está en las actualizaciones
          if (!updates.agent_background && existingCommand.agent_background) {
            updatedCommand.agent_background = existingCommand.agent_background;
          }
          
          // Actualizar en la caché
          CommandCache.cacheCommand(commandId, updatedCommand);
          return updatedCommand;
        } else {
          console.log(`[CommandUpdateService] No se encontró comando existente, creando uno parcial`);
          // Devolver un objeto parcial con los valores actualizados
          const newCommand = {
            id: commandId,
            task: 'unknown',
            status: 'pending',
            user_id: 'unknown',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...updates
          } as AgentbaseDbCommand;
          
          // Actualizar en la caché
          CommandCache.cacheCommand(commandId, newCommand);
          return newCommand;
        }
      }
    } catch (error: any) {
      console.error(`[CommandUpdateService] Error crítico actualizando comando ${commandId}:`, error);
      
      // Si hay un comando en caché, intentar actualizarlo igualmente
      if (cachedCommand) {
        console.log(`[CommandUpdateService] Actualizando comando en caché a pesar del error`);
        const updatedCommand = {
          ...cachedCommand,
          ...updates,
          updated_at: new Date().toISOString()
        };
        
        // Preservar agent_background si no está en las actualizaciones
        if (!updates.agent_background && cachedCommand.agent_background) {
          updatedCommand.agent_background = cachedCommand.agent_background;
        }
        
        // Actualizar en la caché
        CommandCache.cacheCommand(commandId, updatedCommand);
        return updatedCommand;
      }
      
      // Intentar actualizar solo el estado si la actualización completa falló y hay un cambio de estado
      if (dbUpdates.status && isValidUUID(commandId)) {
        try {
          console.log(`🔄 [CommandUpdateService] Intentando actualizar SOLO el estado como último recurso`);
          const { error: lastError } = await supabaseAdmin
            .from('commands')
            .update({ status: dbUpdates.status })
            .eq('id', commandId);
          
          if (!lastError) {
            console.log(`✅ [CommandUpdateService] Actualización de emergencia de estado exitosa para ${commandId}`);
            
            // Devolver un objeto parcial con al menos el estado actualizado
            return {
              id: commandId,
              status: updates.status || 'unknown',
              task: 'status_emergency_update',
              user_id: 'system',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            } as AgentbaseDbCommand;
          }
        } catch (lastAttemptError) {
          console.error(`💥 [CommandUpdateService] Falló último intento de actualizar estado:`, lastAttemptError);
        }
      }
      
      throw new Error(`Error updating command ${commandId}: ${error.message}`);
    }
  }
} 