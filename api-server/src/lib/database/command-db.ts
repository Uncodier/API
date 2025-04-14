import { supabaseAdmin } from './supabase-client'

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
  context: string | null;
  supervisor: any[] | null;
  created_at?: string;
  updated_at?: string;
  completion_date?: string | null;
  duration?: number | null;
  model?: string | null;
  agent_id?: string | null;
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
  context?: string;
  supervisor?: any[];
  model?: string;
  agent_id?: string;
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
    const { data, error } = await supabaseAdmin
      .from('commands')
      .insert(command)
      .select()
      .single();
    
    if (error) {
      console.error('Error creating command:', error);
      throw new Error(`Error creating command: ${error.message}`);
    }
    
    return data;
  } catch (error: any) {
    console.error('Error in createCommand:', error);
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
    // Depuración específica para tokens
    if (updates.input_tokens !== undefined || updates.output_tokens !== undefined) {
      console.log(`[command-db] 🔍 Tokens recibidos: input_tokens=${updates.input_tokens}, output_tokens=${updates.output_tokens}`);
    }
    
    console.log(`[command-db] Actualizando comando ${commandId} con:`, JSON.stringify(updates, null, 2).substring(0, 500) + '...');
    
    // Asegurarse de que siempre actualizamos updated_at
    const updatesWithTimestamp = {
      ...updates,
      updated_at: new Date().toISOString()
    };
    
    // Depuración posterior a preparación
    if (updates.input_tokens !== undefined || updates.output_tokens !== undefined) {
      console.log(`[command-db] 🔍 Tokens después de preparación: input_tokens=${updatesWithTimestamp.input_tokens}, output_tokens=${updatesWithTimestamp.output_tokens}`);
    }
    
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
    
    console.log(`[command-db] Comando encontrado, estado actual: ${existingCommand.status}`);
    
    // Imprimir estructura de tabla para diagnóstico
    if (updates.input_tokens !== undefined || updates.output_tokens !== undefined) {
      const { data: tableInfo, error: tableError } = await supabaseAdmin.rpc('get_column_info', { 
        table_name: 'commands' 
      });
      
      if (!tableError) {
        console.log(`[command-db] 🔍 Columnas en tabla commands:`, tableInfo);
      }
    }
    
    // Ahora actualizamos el comando
    const { data, error } = await supabaseAdmin
      .from('commands')
      .update(updatesWithTimestamp)
      .eq('id', commandId)
      .select()
      .single();
    
    if (error) {
      console.error(`[command-db] Error al actualizar comando ${commandId}:`, error);
      throw new Error(`Error updating command: ${error.message}`);
    }
    
    console.log(`[command-db] Comando ${commandId} actualizado con éxito`);
    console.log(`[command-db] Comando actualizado:`, JSON.stringify(data, null, 2).substring(0, 500) + '...');
    
    // Verificar si los tokens se actualizaron
    if (updates.input_tokens !== undefined || updates.output_tokens !== undefined) {
      console.log(`[command-db] 🔍 Tokens después de actualización: input_tokens=${data.input_tokens}, output_tokens=${data.output_tokens}`);
      
      // Si no se actualizaron los tokens, intentar una actualización específica solo para tokens
      if ((updates.input_tokens !== undefined && data.input_tokens !== updates.input_tokens) || 
          (updates.output_tokens !== undefined && data.output_tokens !== updates.output_tokens)) {
        console.log(`[command-db] ⚠️ Los tokens no se actualizaron correctamente, intentando actualización específica`);
        
        const tokenUpdates = {
          input_tokens: updates.input_tokens,
          output_tokens: updates.output_tokens
        };
        
        const { data: tokenData, error: tokenError } = await supabaseAdmin
          .from('commands')
          .update(tokenUpdates)
          .eq('id', commandId)
          .select()
          .single();
          
        if (tokenError) {
          console.error(`[command-db] Error en actualización específica de tokens:`, tokenError);
        } else {
          console.log(`[command-db] ✅ Actualización específica de tokens completada: input_tokens=${tokenData.input_tokens}, output_tokens=${tokenData.output_tokens}`);
          return tokenData;
        }
      }
    }
    
    return data;
  } catch (error: any) {
    console.error(`[command-db] Error crítico en updateCommand para ${commandId}:`, error);
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
 * Gets a command by ID
 * 
 * @param commandId Command ID
 * @returns The command or null if not found
 */
export async function getCommandById(commandId: string): Promise<DbCommand | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('commands')
      .select('*')
      .eq('id', commandId)
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      console.error('Error getting command by ID:', error);
      throw new Error(`Error getting command: ${error.message}`);
    }
    
    return data;
  } catch (error: any) {
    console.error('Error in getCommandById:', error);
    throw new Error(`Error getting command: ${error.message}`);
  }
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