import { supabaseAdmin } from './supabase-client'
import { circuitBreakers } from '@/lib/utils/circuit-breaker'

/**
 * Type for command status enum
 */
export type CommandStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Interface for commands in the database
 */
export interface DbCommand {
  id: string;
  task: string;
  status: CommandStatus;
  description: string | null;
  results: any[] | null;
  targets: any[] | null;
  tools: any[] | null;
  functions: any[] | null;
  context: string | null;
  supervisor: any[] | null;
  created_at?: string;
  updated_at?: string;
  completion_date?: string | null;
  duration?: number | null;
  model?: string | null;
  agent_id?: string | null;
  agent_background?: string | null;  // Agent background information
  user_id: string;
  input_tokens?: number | null;  // Tokens de entrada acumulados
  output_tokens?: number | null; // Tokens de salida acumulados
  site_id?: string | null;       // Site identifier
}

/**
 * Interface for creating a new command
 */
export interface CreateCommandParams {
  id?: string;
  task: string;
  status?: CommandStatus;
  description?: string;
  results?: any[];
  targets?: any[];
  tools?: any[];
  functions?: any[];
  context?: string;
  supervisor?: any[];
  model?: string;
  agent_id?: string;
  agent_background?: string;  // Agent background information
  user_id: string;
  input_tokens?: number;  // Tokens de entrada acumulados
  output_tokens?: number; // Tokens de salida acumulados
  site_id?: string;       // Site identifier
}

/**
 * Creates a new command in the database
 * 
 * @param command Command data
 * @returns The created command
 */
export async function createCommand(command: CreateCommandParams): Promise<DbCommand> {
  try {
    // Log detallado del comando antes de enviarlo a Supabase
    console.log(`[command-db] Creando comando con agent_background: ${command.agent_background ? 'SÍ' : 'NO'}`);
    if (command.agent_background) {
      console.log(`[command-db] Longitud de agent_background: ${command.agent_background.length} caracteres`);
      console.log(`[command-db] Primeros 100 caracteres: ${command.agent_background.substring(0, 100)}...`);
    }
    
    const { data, error } = await supabaseAdmin
      .from('commands')
      .insert(command)
      .select()
      .single();
    
    if (error) {
      console.error('[command-db] Error creating command:', error);
      throw new Error(`Error creating command: ${error.message}`);
    }
    
    // Verificar si el comando creado tiene agent_background
    console.log(`[command-db] Comando creado exitosamente: ${data.id}`);
    console.log(`[command-db] Agent_background en respuesta: ${data.agent_background ? 'SÍ' : 'NO'}`);
    if (data.agent_background) {
      console.log(`[command-db] Longitud en respuesta: ${data.agent_background.length} caracteres`);
    }
    
    return data;
  } catch (error: any) {
    console.error('[command-db] Error in createCommand:', error);
    throw new Error(`Error creating command: ${error.message}`);
  }
}

/**
 * Updates a command in the database
 * 
 * @param commandId Command ID
 * @param updates Updates to apply
 * @returns The updated command
 */
export async function updateCommand(
  commandId: string, 
  updates: Partial<Omit<DbCommand, 'id' | 'created_at' | 'updated_at'>>
): Promise<DbCommand> {
  try {
    // Agregar timestamps
    const now = new Date().toISOString();
    
    // Preparar las actualizaciones
    const updateData: any = {
      ...updates,
      updated_at: now
    };
    
    // Log detallado para tokens
    if (updateData.input_tokens !== undefined || updateData.output_tokens !== undefined) {
      console.log('[command-db] 🔍 Tokens recibidos: input_tokens=' + 
        (updateData.input_tokens !== undefined ? updateData.input_tokens : 'no definido') + 
        ', output_tokens=' + 
        (updateData.output_tokens !== undefined ? updateData.output_tokens : 'no definido'));
    }
    
    // IMPORTANTE: Validación especial para resultados
    if (updateData.results !== undefined) {
      console.log(`[command-db] 🔍 Resultados recibidos: ${Array.isArray(updateData.results) ? updateData.results.length : 'no es array'} elementos`);
      
      // Asegurar que results siempre sea un array
      if (!Array.isArray(updateData.results)) {
        if (updateData.results === null || updateData.results === undefined) {
          updateData.results = [];
          console.log('[command-db] ⚠️ results es null/undefined, convertido a array vacío');
        } else {
          updateData.results = [updateData.results];
          console.log('[command-db] ⚠️ results no es array, convertido a array con 1 elemento');
        }
      }
      
      // Verificar si existen elementos en el array
      if (updateData.results.length > 0) {
        // Verificar formato del primer elemento para diagnóstico
        const firstResult = updateData.results[0];
        console.log(`[command-db] 🔍 Primer resultado: ${typeof firstResult === 'object' ? 
          JSON.stringify(firstResult).substring(0, 200) + '...' : 
          String(firstResult).substring(0, 200) + '...'}`);
      }
    }
    
    // Actualizar en base de datos
    const { data, error } = await supabaseAdmin
      .from('commands')
      .update(updateData)
      .eq('id', commandId)
      .select();
    
    if (error) {
      console.error('[command-db] Error actualizando comando:', error);
      throw new Error(`Error updating command: ${error.message}`);
    }
    
    if (!data || data.length === 0) {
      throw new Error(`Command with ID ${commandId} not found or not updated`);
    }
    
    // Log detallado para tokens después de la actualización
    if (updateData.input_tokens !== undefined || updateData.output_tokens !== undefined) {
      console.log('[command-db] 🔍 Tokens después de actualización: input_tokens=' + 
        (data[0].input_tokens !== undefined ? data[0].input_tokens : 'no definido') + 
        ', output_tokens=' + 
        (data[0].output_tokens !== undefined ? data[0].output_tokens : 'no definido'));
    }
    
    // Log para results después de la actualización
    if (updateData.results !== undefined) {
      console.log(`[command-db] 🔍 Resultados después de actualización: ${Array.isArray(data[0].results) ? 
        data[0].results.length : 'no es array'} elementos`);
    }
    
    console.log(`[command-db] Comando ${commandId} actualizado con éxito`);
    
    // Mostrar todo el comando actualizado para diagnóstico (limitado a 400 caracteres)
    console.log(`[command-db] Comando actualizado:`, JSON.stringify(data[0], null, 2).substring(0, 400) + '...');
    
    return data[0];
  } catch (error: any) {
    console.error('[command-db] Error en updateCommand:', error);
    throw new Error(`Error updating command: ${error.message}`);
  }
}

/**
 * Updates the status of a command
 * 
 * @param commandId Command ID
 * @param status New status
 * @returns true if successfully updated
 */
export async function updateCommandStatus(
  commandId: string, 
  status: CommandStatus
): Promise<boolean> {
  try {
    console.log(`[command-db] Actualizando estado del comando ${commandId} a ${status}`);
    
    // Primero verificamos si el comando existe
    const { data: existingCommand, error: checkError } = await supabaseAdmin
      .from('commands')
      .select('*')
      .eq('id', commandId)
      .single();
    
    if (checkError) {
      console.error(`[command-db] Error verificando existencia del comando ${commandId}:`, checkError);
      if (checkError.code === 'PGRST116') {
        console.error(`[command-db] El comando ${commandId} no existe en la base de datos.`);
      }
      throw new Error(`Error verificando comando: ${checkError.message}`);
    }
    
    console.log(`[command-db] Comando encontrado, estado actual: ${existingCommand.status}, actualizando a: ${status}`);
    
    // Ahora actualizamos el comando
    const { data, error } = await supabaseAdmin
      .from('commands')
      .update({ 
        status,
        updated_at: new Date().toISOString()
      })
      .eq('id', commandId)
      .select()
      .single();
    
    if (error) {
      console.error(`[command-db] Error al actualizar estado del comando ${commandId}:`, error);
      throw new Error(`Error updating command status: ${error.message}`);
    }
    
    console.log(`[command-db] Estado del comando ${commandId} actualizado con éxito a ${status}`);
    console.log(`[command-db] Comando actualizado:`, JSON.stringify(data, null, 2).substring(0, 500) + '...');
    
    return true;
  } catch (error: any) {
    console.error(`[command-db] Error crítico en updateCommandStatus para ${commandId}:`, error);
    throw new Error(`Error updating command status: ${error.message}`);
  }
}

/**
 * Retry function with exponential backoff
 */
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
  operationName: string = 'operation'
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      
      // Don't retry for certain error types
      if (error.code === 'PGRST116' || error.message?.includes('not found')) {
        throw error;
      }
      
      if (attempt === maxRetries) {
        console.error(`❌ [${operationName}] Final attempt failed after ${maxRetries} retries:`, error);
        throw error;
      }
      
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.warn(`⚠️ [${operationName}] Attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms:`, error.message);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError!;
}

/**
 * Gets a command by ID with retry logic
 * 
 * @param commandId Command ID
 * @returns The command or null if not found
 */
export async function getCommandById(commandId: string): Promise<DbCommand | null> {
  return circuitBreakers.database.execute(async () => {
    return retryWithBackoff(async () => {
      try {
        // Asegurarnos de seleccionar explícitamente agent_background
        const { data, error } = await supabaseAdmin
          .from('commands')
          .select('*, agent_background')
          .eq('id', commandId)
          .single();
      
      if (error) {
        if (error.code === 'PGRST116') {
          return null; // Not found
        }
        console.error('Error getting command by ID:', {
          message: error.message,
          details: error.details || 'No additional details',
          hint: error.hint || '',
          code: error.code || ''
        });
        throw new Error(`Error getting command: ${error.message}`);
      }
      
      // Log if agent_background is present
      if (data && data.agent_background) {
        console.log(`📋 Command ${commandId} has agent_background of length: ${data.agent_background.length}`);
        // Verificar que el agent_background no esté vacío o corrupto
        if (data.agent_background.length < 10) {
          console.warn(`⚠️ ADVERTENCIA: agent_background es muy corto (${data.agent_background.length} caracteres)`);
        }
      } else {
        console.log(`📋 Command ${commandId} does not have agent_background`);
      }
      
      return data;
    } catch (error: any) {
      console.error('Error in getCommandById:', {
        message: error.message,
        details: error instanceof Error ? error.stack : String(error),
        commandId
      });
      throw error;
    }
  }, 3, 1000, `getCommandById(${commandId})`);
  });
}

/**
 * Gets commands for a user
 * 
 * @param userId User ID
 * @param limit Maximum number of commands to return
 * @param offset Offset for pagination
 * @returns Array of commands
 */
export async function getCommandsByUser(
  userId: string,
  limit: number = 50,
  offset: number = 0
): Promise<DbCommand[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('commands')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    
    if (error) {
      console.error('Error getting commands by user:', error);
      throw new Error(`Error getting commands: ${error.message}`);
    }
    
    return data || [];
  } catch (error: any) {
    console.error('Error in getCommandsByUser:', error);
    throw new Error(`Error getting commands: ${error.message}`);
  }
}

/**
 * Gets commands for an agent
 * 
 * @param agentId Agent ID
 * @param limit Maximum number of commands to return
 * @param offset Offset for pagination
 * @returns Array of commands
 */
export async function getCommandsByAgent(
  agentId: string,
  limit: number = 50,
  offset: number = 0
): Promise<DbCommand[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('commands')
      .select('*')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    
    if (error) {
      console.error('Error getting commands by agent:', error);
      throw new Error(`Error getting commands: ${error.message}`);
    }
    
    return data || [];
  } catch (error: any) {
    console.error('Error in getCommandsByAgent:', error);
    throw new Error(`Error getting commands: ${error.message}`);
  }
}

/**
 * Adds a result to a command's results array
 * 
 * @param commandId Command ID
 * @param result Result to add
 * @returns true if successfully updated
 */
export async function addCommandResult(
  commandId: string,
  result: any
): Promise<boolean> {
  try {
    // First get the current results
    const command = await getCommandById(commandId);
    
    if (!command) {
      throw new Error(`Command with ID ${commandId} not found`);
    }
    
    // Combine current results with new result
    const updatedResults = [...(command.results || []), result];
    
    // Update the command
    const { error } = await supabaseAdmin
      .from('commands')
      .update({ 
        results: updatedResults,
        updated_at: new Date().toISOString()
      })
      .eq('id', commandId);
    
    if (error) {
      console.error('Error adding command result:', error);
      throw new Error(`Error adding command result: ${error.message}`);
    }
    
    return true;
  } catch (error: any) {
    console.error('Error in addCommandResult:', error);
    throw new Error(`Error adding command result: ${error.message}`);
  }
} 