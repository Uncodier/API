/**
 * Database Adapter for Agentbase
 * 
 * Esta clase adapta los tipos entre la biblioteca Agentbase y la base de datos.
 */

import {
  DbCommand as AgentbaseDbCommand,
  CommandStatus as AgentbaseCommandStatus,
  CreateCommandParams as AgentbaseCreateCommandParams
} from '../models/types';

import {
  DbCommand as DbCommandModel,
  CommandStatus as DbCommandStatus, 
  CreateCommandParams as DbCreateCommandParams,
  createCommand as dbCreateCommand, 
  updateCommand as dbUpdateCommand,
  updateCommandStatus as dbUpdateCommandStatus,
  getCommandById as dbGetCommandById
} from '@/lib/database/command-db';

import { supabaseAdmin } from '@/lib/database/supabase-client';

// Función más robusta para generar un UUID v4 válido para PostgreSQL
function generateUUID(): string {
  // Utiliza crypto.randomUUID() si está disponible (entornos modernos)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  
  // Implementación de respaldo para entornos que no tienen crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Función para extraer el ID de conversación del contexto
function extractConversationId(context: string): string | null {
  if (!context) return null;
  
  // First try the "Conversation ID: UUID" format
  let match = context.match(/Conversation ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  if (match) return match[1];
  
  // Then try just "conversationId: UUID" format
  match = context.match(/conversationId:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  if (match) return match[1];
  
  // Try to find any UUID in the context
  match = context.match(/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  return match ? match[1] : null;
}


// Función simplificada que sólo valida que targets exista, sin transformar su estructura
function ensureTargetContentExists(targets: any[]): any[] {
  // Si targets no existe o no es un array, devolver array vacío
  if (!targets || !Array.isArray(targets)) return [];
  
  // Simplemente devolver el array de targets sin modificar su estructura
  return targets;
}


export class DatabaseAdapter {
  /**
   * Convierte un comando Agentbase a un formato de base de datos
   */
  static toDbFormat(command: AgentbaseCreateCommandParams): DbCreateCommandParams {
    console.log("Convirtiendo comando al formato de DB:", JSON.stringify({
      task: command.task,
      agent_id: command.agent_id,
      user_id: command.user_id
    }));
    
    // Crear un objeto base solo con los campos obligatorios
    const dbCommand: Partial<DbCreateCommandParams> = {
      id: generateUUID(),
      task: command.task,
      user_id: command.user_id,
    };

    // Añadir status solo si está definido
    if (command.status) {
      dbCommand.status = this.convertStatusToDb(command.status);
    }
    
    // Añadir campos opcionales solo si están definidos y no son null/undefined
    if (command.description !== undefined && command.description !== null) {
      dbCommand.description = command.description;
    }
    
    // Include site_id if provided
    if (command.site_id !== undefined && command.site_id !== null) {
      dbCommand.site_id = command.site_id;
    }
    
    // Procesar los targets para asegurar que siempre tengan content, aunque sea null
    if (command.targets && Array.isArray(command.targets)) {
      const processedTargets = ensureTargetContentExists(command.targets);
      dbCommand.targets = processedTargets;
      console.log("Targets procesados:", JSON.stringify(processedTargets));
    }
    
    if (command.tools && Array.isArray(command.tools) && command.tools.length > 0) {
      dbCommand.tools = command.tools;
    }
    
    // Procesar el contexto de conversación
    if (command.context !== undefined && command.context !== null) {
      dbCommand.context = command.context;
      
    
    }
    
    if (command.supervisor && Array.isArray(command.supervisor) && command.supervisor.length > 0) {
      dbCommand.supervisor = command.supervisor;
    }
    
    if (command.model !== undefined && command.model !== null) {
      dbCommand.model = command.model;
    }
    
    // Solo incluir agent_id si es un UUID válido
    if (command.agent_id && this.isValidUUID(command.agent_id)) {
      console.log(`Agent ID '${command.agent_id}' es un UUID válido, incluyéndolo`);
      dbCommand.agent_id = command.agent_id;
    } else if (command.agent_id) {
      console.log(`Agent ID '${command.agent_id}' no es un UUID válido, excluyéndolo`);
      // Almacenar el agentId en el contexto para mantener referencia
      if (dbCommand.context) {
        dbCommand.context += `\nOriginal Agent ID: ${command.agent_id}`;
      } else {
        dbCommand.context = `Original Agent ID: ${command.agent_id}`;
      }
    }
    
    console.log("Comando convertido:", JSON.stringify(dbCommand));
    
    return dbCommand as DbCreateCommandParams;
  }
  
  /**
   * Verifica si una cadena es un UUID válido
   */
  static isValidUUID(uuid: string): boolean {
    if (!uuid) return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }
  
  /**
   * Convierte un comando de base de datos a formato Agentbase
   */
  static toAgentbaseFormat(dbCommand: DbCommandModel): AgentbaseDbCommand {
    console.log("Convirtiendo comando de DB a formato Agentbase:", JSON.stringify({
      id: dbCommand.id,
      task: dbCommand.task,
      status: dbCommand.status,
      agent_id: dbCommand.agent_id
    }));
    
    // Extraer el agentId original del contexto si existe y no tiene un agent_id válido
    let originalAgentId = dbCommand.agent_id;
    if ((!originalAgentId || !this.isValidUUID(originalAgentId)) && dbCommand.context) {
      const match = dbCommand.context.match(/Original Agent ID: (.+)$/m);
      if (match && match[1]) {
        originalAgentId = match[1];
        console.log(`Recuperado Original Agent ID desde contexto: ${originalAgentId}`);
      }
    }
    
    // Asegurarnos de que los targets tengan siempre content, aunque sea null
    const processedTargets = dbCommand.targets ? ensureTargetContentExists(dbCommand.targets) : [];
    
    const agentbaseCommand: AgentbaseDbCommand = {
      id: dbCommand.id,
      task: dbCommand.task,
      status: this.convertStatusToAgentbase(dbCommand.status),
      user_id: dbCommand.user_id,
      created_at: dbCommand.created_at || new Date().toISOString(),
      updated_at: dbCommand.updated_at || new Date().toISOString(),
      
      // Convertir las propiedades opcionales
      description: dbCommand.description || undefined,
      targets: processedTargets,
      tools: dbCommand.tools || [],
      context: dbCommand.context || undefined,
      supervisor: dbCommand.supervisor || [],
      model: dbCommand.model || undefined,
      agent_id: originalAgentId || undefined,
      results: dbCommand.results || [],
      duration: dbCommand.duration || undefined,
      site_id: dbCommand.site_id || undefined,
      
      // Propiedades específicas de Agentbase
      model_type: undefined,
      model_id: undefined,
      max_tokens: undefined,
      temperature: undefined,
      response_format: undefined,
      system_prompt: undefined,
      priority: undefined,
      execution_order: undefined,
      supervision_params: undefined,
      requires_capabilities: undefined
    };
    
    return agentbaseCommand;
  }
  
  /**
   * Convierte un estado de comando de Agentbase a formato de BD
   */
  static convertStatusToDb(status: AgentbaseCommandStatus): DbCommandStatus {
    switch (status) {
      case 'pending':
      case 'running':
      case 'completed':
      case 'failed':
        return status;
      case 'pending_supervision':
        return 'pending'; // Mapeo personalizado
      default:
        return 'pending';
    }
  }
  
  /**
   * Convierte un estado de comando de BD a formato Agentbase
   */
  static convertStatusToAgentbase(status: DbCommandStatus): AgentbaseCommandStatus {
    switch (status) {
      case 'pending':
      case 'running':
      case 'completed':
      case 'failed':
        return status;
      case 'cancelled':
        return 'failed'; // Mapeo personalizado
      default:
        return 'pending';
    }
  }
  
  /**
   * Crea un comando en la base de datos
   */
  static async createCommand(command: AgentbaseCreateCommandParams): Promise<AgentbaseDbCommand> {
    try {
      console.log("Iniciando creación de comando en BD:", JSON.stringify({
        task: command.task,
        agent_id: command.agent_id
      }));
      
      const dbCommandData = this.toDbFormat(command);
      
      console.log("Enviando comando a BD:", JSON.stringify(dbCommandData));
      
      const dbCommand = await dbCreateCommand(dbCommandData);
      
      console.log(`Comando guardado en BD con UUID: ${dbCommand.id}`);
      
      return this.toAgentbaseFormat(dbCommand);
    } catch (error) {
      console.error(`Error al crear comando en BD:`, error);
      throw error;
    }
  }
  
  /**
   * Obtiene un comando por ID
   */
  static async getCommandById(commandId: string): Promise<AgentbaseDbCommand | null> {
    try {
      console.log(`Buscando comando con ID: ${commandId}`);
      
      // Solo intentar obtener el comando de la BD si es un UUID válido
      if (this.isValidUUID(commandId)) {
        console.log(`ID ${commandId} es un UUID válido, buscando en BD`);
        const dbCommand = await dbGetCommandById(commandId);
        
        if (dbCommand) {
          console.log(`Comando encontrado en BD: ${commandId}`);
          return this.toAgentbaseFormat(dbCommand);
        } else {
          console.log(`Comando no encontrado en BD: ${commandId}`);
        }
      } else {
        console.log(`ID no es un UUID válido, no se buscará en BD: ${commandId}`);
      }
      
      return null;
    } catch (error) {
      console.error(`Error getting command ${commandId}:`, error);
      return null;
    }
  }
  
  /**
   * Actualiza el estado de un comando
   */
  static async updateCommandStatus(commandId: string, status: AgentbaseCommandStatus): Promise<boolean> {
    try {
      console.log(`Actualizando estado de comando ${commandId} a ${status}`);
      
      // Solo actualizar en la BD si es un UUID válido
      if (this.isValidUUID(commandId)) {
        console.log(`ID ${commandId} es un UUID válido, actualizando en BD`);
        return await dbUpdateCommandStatus(commandId, this.convertStatusToDb(status));
      } else {
        console.log(`ID no es un UUID válido, no se actualizará en BD: ${commandId}`);
        return false;
      }
    } catch (error) {
      console.error(`Error updating status for command ${commandId}:`, error);
      return false;
    }
  }
  
  /**
   * Actualiza un comando
   */
  static async updateCommand(
    commandId: string,
    updates: Partial<Omit<AgentbaseDbCommand, 'id' | 'created_at' | 'updated_at'>>
  ): Promise<AgentbaseDbCommand> {
    console.log(`[DatabaseAdapter] Actualizando comando ${commandId} con:`, 
      typeof updates === 'object' ? 
        JSON.stringify(updates, null, 2).substring(0, 300) + '...' : 
        'undefined o no válido');
    
    // Verificar si hay actualizaciones
    if (!updates || Object.keys(updates).length === 0) {
      console.warn(`[DatabaseAdapter] No hay campos para actualizar en el comando ${commandId}`);
      
      // Intentar obtener el comando existente
      const existingCommand = await this.getCommandById(commandId);
      if (existingCommand) {
        console.log(`[DatabaseAdapter] Devolviendo comando existente sin cambios`);
        return existingCommand;
      } else {
        throw new Error(`No updates provided and command not found: ${commandId}`);
      }
    }
    
    // Primero necesitamos adaptar los campos a actualizar
    const dbUpdates: any = {};
    
    // Añadir solo campos que están definidos
    if (updates.status !== undefined) {
      const convertedStatus = this.convertStatusToDb(updates.status);
      console.log(`[DatabaseAdapter] Actualizando status de '${updates.status}' a formato DB: '${convertedStatus}'`);
      dbUpdates.status = convertedStatus;
    }
    
    if (updates.task !== undefined) {
      console.log(`[DatabaseAdapter] Actualizando task: ${updates.task.substring(0, 50)}...`);
      dbUpdates.task = updates.task;
    }
    
    if (updates.description !== undefined) {
      console.log(`[DatabaseAdapter] Actualizando description`);
      dbUpdates.description = updates.description;
    }
    
    // Procesar los targets para asegurar que siempre tengan content, aunque sea null
    if (updates.targets !== undefined) {
      console.log(`[DatabaseAdapter] Procesando targets para comando ${commandId}`);
      const processedTargets = ensureTargetContentExists(updates.targets);
      dbUpdates.targets = processedTargets;
      console.log(`[DatabaseAdapter] Targets actualizados:`, 
        JSON.stringify(processedTargets, null, 2).substring(0, 300) + '...');
    }
    
    if (updates.tools !== undefined) {
      console.log(`[DatabaseAdapter] Actualizando ${updates.tools.length} tools`);
      dbUpdates.tools = updates.tools;
    }
    
    // Procesar el contexto de conversación
    if (updates.context !== undefined) {
      console.log(`[DatabaseAdapter] Actualizando context`);
      dbUpdates.context = updates.context;
      
      // Extraer el conversationId si existe (solo para logging)
      const conversationId = extractConversationId(updates.context);
      if (conversationId) {
        console.log(`[DatabaseAdapter] Conversación ID encontrado en actualización: ${conversationId}`);
      }
    }
    
    if (updates.supervisor !== undefined) {
      console.log(`[DatabaseAdapter] Actualizando supervisor`);
      dbUpdates.supervisor = updates.supervisor;
    }
    
    if (updates.model !== undefined) {
      console.log(`[DatabaseAdapter] Actualizando model: ${updates.model}`);
      dbUpdates.model = updates.model;
    }
    
    // Procesamiento especial para asegurar correcta actualización de resultados
    if (updates.results !== undefined) {
      console.log(`[DatabaseAdapter] Actualizando ${updates.results?.length || 0} resultados para comando ${commandId}`);
      
      // Verificar que results sea un array
      if (!Array.isArray(updates.results)) {
        console.warn(`[DatabaseAdapter] results no es un array, convirtiendo:`, updates.results);
        dbUpdates.results = updates.results ? [updates.results] : [];
      } else {
        // Verificar cada resultado para asegurar que tenga una estructura válida
        const validResults = updates.results.filter(result => {
          // ACTUALIZACIÓN: Aceptar cualquier objeto como válido, respetando completamente
          // la estructura original de los targets
          const isValid = result && typeof result === 'object';
          if (!isValid) {
            console.warn(`[DatabaseAdapter] Resultado inválido ignorado:`, result);
          }
          return isValid;
        });
        
        // Diagnóstico de resultados
        if (validResults.length === 0 && updates.results.length > 0) {
          console.warn(`[DatabaseAdapter] ADVERTENCIA: Todos los resultados fueron considerados inválidos.`);
          console.log(`[DatabaseAdapter] Primer resultado original:`, JSON.stringify(updates.results[0]));
        }
        
        if (validResults.length > 0) {
          console.log(`[DatabaseAdapter] Ejemplo de resultado válido:`, JSON.stringify(validResults[0]).substring(0, 200) + '...');
        }
        
        dbUpdates.results = validResults;
        console.log(`[DatabaseAdapter] ${validResults.length} resultados válidos encontrados de ${updates.results.length} originales`);
      }
    }
    
    // Añadir metadata a las actualizaciones si existe
    if (updates.metadata) {
      console.log(`[DatabaseAdapter] Actualizando metadata`);
      dbUpdates.metadata = updates.metadata;
    }
    
    // Añadir tokens si están definidos
    if (updates.input_tokens !== undefined) {
      console.log(`[DatabaseAdapter] Actualizando input_tokens: ${updates.input_tokens}`);
      dbUpdates.input_tokens = updates.input_tokens;
    }
    
    if (updates.output_tokens !== undefined) {
      console.log(`[DatabaseAdapter] Actualizando output_tokens: ${updates.output_tokens}`);
      dbUpdates.output_tokens = updates.output_tokens;
    }
    
    // Manejar específicamente agent_background para asegurar que se guarde correctamente
    if (updates.agent_background !== undefined) {
      console.log(`[DatabaseAdapter] Actualizando agent_background: ${updates.agent_background?.substring(0, 100)}...`);
      
      // Agregar directamente al objeto de actualizaciones
      dbUpdates.agent_background = updates.agent_background;
      
      // Log para depuración
      console.log(`[DatabaseAdapter] Valor de agent_background incluido en actualizaciones: ${dbUpdates.agent_background?.substring(0, 100)}...`);
    }
    
    // Manejar el agent_id específicamente
    if (updates.agent_id) {
      if (this.isValidUUID(updates.agent_id)) {
        console.log(`Agent ID para actualización '${updates.agent_id}' es un UUID válido, incluyéndolo`);
        dbUpdates.agent_id = updates.agent_id;
      } else {
        console.log(`Agent ID para actualización '${updates.agent_id}' no es un UUID válido, excluyéndolo`);
        // Almacenar en contexto
        if (updates.context) {
          updates.context += `\nOriginal Agent ID: ${updates.agent_id}`;
          dbUpdates.context = updates.context;
        } else if (dbUpdates.context) {
          dbUpdates.context += `\nOriginal Agent ID: ${updates.agent_id}`;
        } else {
          dbUpdates.context = `Original Agent ID: ${updates.agent_id}`;
        }
      }
    }
    
    // Realizar la actualización
    try {
      // Solo actualizar en la BD si es un UUID válido
      if (this.isValidUUID(commandId)) {
        console.log(`[DatabaseAdapter] ID ${commandId} es un UUID válido, enviando actualización a BD`);
        
        // Antes de actualizar, verificar que el comando existe
        const existingCommand = await dbGetCommandById(commandId);
        if (!existingCommand) {
          console.error(`[DatabaseAdapter] Error: El comando ${commandId} no existe en la base de datos`);
          throw new Error(`Command not found: ${commandId}`);
        }
        
        console.log(`[DatabaseAdapter] Comando existente encontrado en BD, estado actual: ${existingCommand.status}`);
        console.log(`[DatabaseAdapter] Enviando actualizaciones a BD:`, JSON.stringify(dbUpdates, null, 2).substring(0, 300) + '...');
        
        // Realizar la actualización
        const dbCommand = await dbUpdateCommand(commandId, dbUpdates);
        console.log(`[DatabaseAdapter] Comando ${commandId} actualizado exitosamente, nuevo estado: ${dbCommand.status}`);
        
        // Verificar que se actualizaron los resultados si estaban presentes en la actualización
        if (updates.results !== undefined && (!dbCommand.results || dbCommand.results.length === 0)) {
          console.warn(`[DatabaseAdapter] ADVERTENCIA: Los resultados no se actualizaron correctamente en el comando ${commandId}`);
          console.log(`[DatabaseAdapter] Realizando una segunda actualización solo para resultados...`);
          
          try {
            // Hacer una actualización específica solo para resultados con estructura simplificada
            const simplifiedResults = dbUpdates.results.map((r: any) => {
              // Mantener solo los campos esenciales para reducir complejidad
              return {
                type: r.type,
                content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content)
              };
            });
            
            console.log(`[DatabaseAdapter] Intentando actualizar con resultados simplificados:`, 
              JSON.stringify(simplifiedResults, null, 2).substring(0, 300));
            
            // Intentar primero con Supabase directamente para diagnóstico
            console.log(`[DatabaseAdapter] Actualizando resultados directamente con Supabase...`);
            const { data, error } = await supabaseAdmin
              .from('commands')
              .update({ results: simplifiedResults })
              .eq('id', commandId)
              .select();
            
            if (error) {
              console.error(`[DatabaseAdapter] Error con Supabase:`, error);
              
              // Intentar con la función regular de actualización
              const retryUpdate = await dbUpdateCommand(commandId, { results: simplifiedResults });
              console.log(`[DatabaseAdapter] Segunda actualización completada con función normal, resultados: ${retryUpdate.results?.length || 0}`);
              
              return this.toAgentbaseFormat(retryUpdate);
            } else {
              console.log(`[DatabaseAdapter] Actualización directa con Supabase exitosa, filas: ${data?.length || 0}`);
              
              if (data && data.length > 0) {
                return this.toAgentbaseFormat(data[0]);
              }
            }
          } catch (retryError: any) {
            console.error(`[DatabaseAdapter] Error en segunda actualización: ${retryError.message}`);
            // Continuar con la versión original si falla la segunda actualización
          }
        }
        
        // Convertir y devolver el comando actualizado
        const formattedCommand = this.toAgentbaseFormat(dbCommand);
        console.log(`[DatabaseAdapter] Comando formateado para devolver:`, JSON.stringify(formattedCommand, null, 2).substring(0, 300) + '...');
        return formattedCommand;
      } else {
        console.log(`[DatabaseAdapter] ID ${commandId} no es un UUID válido, no se actualizará en BD`);
        
        // Buscar si hay un comando existente en memoria
        const existingCommand = await this.getCommandById(commandId);
        if (existingCommand) {
          console.log(`[DatabaseAdapter] Comando existente encontrado en memoria, actualizando localmente`);
          return {
            ...existingCommand,
            ...updates,
            updated_at: new Date().toISOString()
          };
        } else {
          console.log(`[DatabaseAdapter] No se encontró comando existente, creando uno parcial`);
          // Devolver un objeto parcial con los valores actualizados
          return {
            id: commandId,
            task: 'unknown',
            status: 'pending',
            user_id: 'unknown',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...updates
          } as AgentbaseDbCommand;
        }
      }
    } catch (error: any) {
      console.error(`[DatabaseAdapter] Error crítico actualizando comando ${commandId}:`, error);
      console.error(`[DatabaseAdapter] Detalles de actualización que falló:`, JSON.stringify(dbUpdates, null, 2).substring(0, 300) + '...');
      throw new Error(`Error updating command ${commandId}: ${error.message}`);
    }
  }

  /**
   * Verifica explícitamente si un comando tiene agent_background en la base de datos
   */
  static async verifyAgentBackground(commandId: string): Promise<{ hasBackground: boolean, value: string | null }> {
    try {
      console.log(`[DatabaseAdapter] Verificando agent_background para comando ${commandId}`);
      
      // Verificar si es un UUID válido
      if (!this.isValidUUID(commandId)) {
        console.warn(`[DatabaseAdapter] ID inválido ${commandId}, no se puede verificar agent_background`);
        return { hasBackground: false, value: null };
      }
      
      // Consultar directamente a la base de datos solo por agent_background
      const { data, error } = await supabaseAdmin
        .from('commands')
        .select('agent_background')
        .eq('id', commandId)
        .single();
      
      if (error) {
        console.error(`[DatabaseAdapter] Error verificando agent_background: ${error.message}`);
        return { hasBackground: false, value: null };
      }
      
      const hasBackground = data && data.agent_background !== null && data.agent_background !== undefined;
      console.log(`[DatabaseAdapter] Comando ${commandId} ${hasBackground ? 'TIENE' : 'NO TIENE'} agent_background`);
      
      if (hasBackground) {
        console.log(`[DatabaseAdapter] Valor de agent_background: ${data.agent_background.substring(0, 100)}...`);
      }
      
      return { 
        hasBackground, 
        value: hasBackground ? data.agent_background : null 
      };
    } catch (error: any) {
      console.error(`[DatabaseAdapter] Error al verificar agent_background: ${error.message}`);
      return { hasBackground: false, value: null };
    }
  }

  /**
   * Obtener información completa del agente desde la base de datos
   * 
   * Este método consulta la tabla 'agents' para obtener toda la información
   * del agente, incluyendo su configuración, prompts y descripción.
   */
  static async getAgentById(agentId: string): Promise<any | null> {
    try {
      if (!this.isValidUUID(agentId)) {
        console.log(`[DatabaseAdapter] ID de agente no válido: ${agentId}`);
        return null;
      }
      
      console.log(`[DatabaseAdapter] Obteniendo información del agente: ${agentId}`);
      
      // Consultar el agente en la base de datos con toda su información
      const { data, error } = await supabaseAdmin
        .from('agents')
        .select('*')
        .eq('id', agentId)
        .single();
      
      if (error) {
        console.error('[DatabaseAdapter] Error al obtener información del agente:', error);
        return null;
      }
      
      if (!data) {
        console.log(`[DatabaseAdapter] No se encontró el agente con ID: ${agentId}`);
        return null;
      }
      
      // Parse configuration if it's a string
      if (data.configuration && typeof data.configuration === 'string') {
        try {
          data.configuration = JSON.parse(data.configuration);
        } catch (e) {
          console.error('[DatabaseAdapter] Error parsing agent configuration:', e);
        }
      }
      
      console.log(`[DatabaseAdapter] Información del agente recuperada correctamente: ${agentId}`);
      
      // Devolver los datos completos del agente
      return data;
    } catch (error) {
      console.error('[DatabaseAdapter] Error al obtener información del agente:', error);
      return null;
    }
  }

  /**
   * Obtener los archivos asociados a un agente desde la base de datos
   * 
   * Este método consulta la base de datos para obtener todos los archivos
   * vinculados al agente especificado a través de la relación agent_assets.
   */
  static async getAgentFiles(agentId: string): Promise<any[] | null> {
    try {
      if (!this.isValidUUID(agentId)) {
        console.log(`[DatabaseAdapter] ID de agente no válido para obtener archivos: ${agentId}`);
        return null;
      }
      
      console.log(`[DatabaseAdapter] Obteniendo archivos del agente: ${agentId}`);
      
      // Consultar la tabla agent_assets que mantiene la relación directa
      const { data: relationData, error: relationError } = await supabaseAdmin
        .from('agent_assets')
        .select('*')
        .eq('agent_id', agentId);
      
      if (relationError) {
        console.error('[DatabaseAdapter] Error al consultar relaciones agent_assets:', relationError);
        return [];
      }
      
      if (!relationData || relationData.length === 0) {
        console.log(`[DatabaseAdapter] No se encontraron relaciones en agent_assets para el agente: ${agentId}`);
        return [];
      }
      
      console.log(`[DatabaseAdapter] Se encontraron ${relationData.length} relaciones para el agente: ${agentId}`);
      
      // Extraer los IDs de assets
      const assetIds = relationData.map(relation => relation.asset_id);
      console.log(`[DatabaseAdapter] Obteniendo ${assetIds.length} assets por IDs: ${assetIds.join(', ').substring(0, 100)}...`);
      
      // Obtener los assets completos
      const { data: assetsData, error: assetsError } = await supabaseAdmin
        .from('assets')
        .select('*')
        .in('id', assetIds);
      
      if (assetsError) {
        console.error('[DatabaseAdapter] Error al obtener assets:', assetsError);
        return [];
      }
      
      if (!assetsData || assetsData.length === 0) {
        console.log(`[DatabaseAdapter] No se encontraron assets para los IDs de relación`);
        return [];
      }
      
      console.log(`[DatabaseAdapter] Encontrados ${assetsData.length} assets para el agente`);
      return assetsData;
      
    } catch (error) {
      console.error('[DatabaseAdapter] Error al obtener archivos del agente:', error);
      return [];
    }
  }

  /**
   * Leer el contenido de un archivo del agente desde el sistema de almacenamiento
   * 
   * Este método obtiene el contenido de un archivo específico asociado al agente.
   * Para archivos CSV, se asegura de que estén formateados correctamente.
   */
  static async getAgentFileContent(filePath: string): Promise<string | null> {
    try {
      console.log(`[DatabaseAdapter] Obteniendo contenido del archivo: ${filePath}`);

      // Verificar primero si es una URL completa para descarga directa
      if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        console.log(`🔍 File path es una URL, intentando descarga directa: ${filePath}`);
        try {
          const response = await fetch(filePath);
          if (response.ok) {
            const content = await response.text();
            console.log(`[DatabaseAdapter] Contenido obtenido exitosamente de URL directa (${content.length} bytes)`);
            
            // Si es un archivo CSV, hacer una validación rápida
            if (filePath.toLowerCase().endsWith('.csv')) {
              console.log(`[DatabaseAdapter] Validando formato CSV...`);
              if (content.includes(',') && (content.includes('\n') || content.includes('\r'))) {
                console.log(`[DatabaseAdapter] El contenido parece ser un CSV válido`);
                
                // Mostrar las primeras filas para debug
                const rows = content.split(/\r?\n/).filter(row => row.trim());
                if (rows.length > 0) {
                  console.log(`[DatabaseAdapter] CSV tiene ${rows.length} filas. Primera fila: ${rows[0]}`);
                  if (rows.length > 1) {
                    console.log(`[DatabaseAdapter] Segunda fila: ${rows[1]}`);
                  }
                }
              }
            }
            
            return content;
          }
        } catch (urlError: any) {
          console.error(`[DatabaseAdapter] Error al obtener contenido de URL directa: ${urlError.message}`);
          // Continuar con otros métodos si falla
        }
      }

      // Verificar si es un UUID - podría ser un ID de asset en lugar de una ruta
      if (this.isValidUUID(filePath)) {
        console.log(`[DatabaseAdapter] Detectado ID de asset, buscando información del archivo: ${filePath}`);
        
        // Obtener información del archivo desde la tabla assets
        const { data: assetData, error: assetError } = await supabaseAdmin
          .from('assets')
          .select('*')
          .eq('id', filePath)
          .single();
          
        if (!assetError && assetData) {
          console.log(`[DatabaseAdapter] Información de asset encontrada, usando ruta: ${assetData.file_path}`);
          
          // Si el asset tiene una URL pública directa, intentar usarla primero
          if (assetData.public_url) {
            console.log(`[DatabaseAdapter] El asset tiene URL pública, intentando obtener de: ${assetData.public_url}`);
            try {
              // Intentar obtener el contenido directamente de la URL pública
              const response = await fetch(assetData.public_url);
              if (response.ok) {
                const content = await response.text();
                console.log(`[DatabaseAdapter] Contenido obtenido exitosamente de URL pública (${content.length} bytes)`);
                
                // Si es un archivo CSV, hacer una validación rápida
                if (assetData.file_type?.toLowerCase() === 'csv' || assetData.file_path?.toLowerCase().endsWith('.csv')) {
                  console.log(`[DatabaseAdapter] Validando formato CSV...`);
                  if (content.includes(',') && (content.includes('\n') || content.includes('\r'))) {
                    console.log(`[DatabaseAdapter] El contenido parece ser un CSV válido`);
                    
                    // Mostrar las primeras filas para debug
                    const rows = content.split(/\r?\n/).filter(row => row.trim());
                    if (rows.length > 0) {
                      console.log(`[DatabaseAdapter] CSV tiene ${rows.length} filas. Primera fila: ${rows[0]}`);
                      if (rows.length > 1) {
                        console.log(`[DatabaseAdapter] Segunda fila: ${rows[1]}`);
                      }
                    }
                  }
                }
                
                return content;
              }
            } catch (urlError: any) {
              console.error(`[DatabaseAdapter] Error al obtener contenido de URL pública: ${urlError.message}`);
              // Continuar con otros métodos si falla
            }
          }
          
          filePath = assetData.file_path;
        } else {
          console.error('[DatabaseAdapter] Error al obtener información del asset:', assetError);
        }
      }
      
      // Usar directamente el bucket 'assets' para archivos de agentes
      const DEFAULT_BUCKET = 'assets';
      let originalPath = filePath;
      
      console.log(`[DatabaseAdapter] Intentando descargar desde bucket predeterminado: ${DEFAULT_BUCKET}, ruta: ${filePath}`);
      
      // Intentar descargar desde el bucket assets
      let { data, error } = await supabaseAdmin
        .storage
        .from(DEFAULT_BUCKET)
        .download(filePath);
      
      // Si falla, intentar con el bucket 'assets' pero con prefijo 'assets/'
      if (error && !filePath.startsWith('assets/')) {
        console.log(`[DatabaseAdapter] Intentando con prefijo 'assets/' en el bucket ${DEFAULT_BUCKET}`);
        const pathWithPrefix = `assets/${filePath}`;
        ({ data, error } = await supabaseAdmin
          .storage
          .from(DEFAULT_BUCKET)
          .download(pathWithPrefix));
          
        if (!error) {
          console.log(`[DatabaseAdapter] Archivo encontrado con prefijo 'assets/' en bucket ${DEFAULT_BUCKET}`);
        }
      }
      
      // Como último recurso, intentar obtener URL pública del bucket assets
      if (error) {
        try {
          console.log(`[DatabaseAdapter] Intentando obtener URL pública de ${DEFAULT_BUCKET}/${filePath}`);
          const { data: urlData } = await supabaseAdmin
            .storage
            .from(DEFAULT_BUCKET)
            .getPublicUrl(filePath);
            
          if (urlData && urlData.publicUrl) {
            console.log(`[DatabaseAdapter] Obteniendo contenido de URL pública: ${urlData.publicUrl}`);
            const response = await fetch(urlData.publicUrl);
            if (response.ok) {
              const content = await response.text();
              console.log(`[DatabaseAdapter] Contenido obtenido de URL pública (${content.length} bytes)`);
              return content;
            }
          }
        } catch (urlError) {
          console.error('[DatabaseAdapter] Error al obtener URL pública:', urlError);
        }
      }
      
      if (error) {
        console.error('[DatabaseAdapter] Error al obtener contenido del archivo:', error);
        return null;
      }
      
      try {
        // Convertir el blob a texto
        if (!data) {
          console.error('[DatabaseAdapter] Datos nulos recibidos de storage');
          return null;
        }
        
        const fileContent = await data.text();
        
        // Para archivos CSV, hacer validación adicional
        if (filePath.toLowerCase().endsWith('.csv')) {
          console.log(`[DatabaseAdapter] Validando formato CSV...`);
          if (fileContent.includes(',') && (fileContent.includes('\n') || fileContent.includes('\r'))) {
            console.log(`[DatabaseAdapter] El contenido parece ser un CSV válido`);
            
            // Mostrar las primeras filas para debug
            const rows = fileContent.split(/\r?\n/).filter(row => row.trim());
            if (rows.length > 0) {
              console.log(`[DatabaseAdapter] CSV tiene ${rows.length} filas. Primera fila: ${rows[0]}`);
              if (rows.length > 1) {
                console.log(`[DatabaseAdapter] Segunda fila: ${rows[1]}`);
              }
            }
          } else {
            console.warn(`[DatabaseAdapter] El contenido no parece tener formato CSV válido`);
          }
        }
        
        return fileContent;
      } catch (textError) {
        console.error('[DatabaseAdapter] Error al convertir blob a texto:', textError);
        return null;
      }
    } catch (error) {
      console.error('[DatabaseAdapter] Error al obtener contenido del archivo:', error);
      return null;
    }
  }
} 