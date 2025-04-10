/**
 * Command Service for managing command lifecycle
 */
import { EventEmitter } from 'events';
import { 
  CreateCommandParams, 
  DbCommand, 
  CommandStatus, 
  SupervisionRequest, 
  SupervisionResponse, 
  SupervisionDecision,
  SupervisionStatus
} from '../models/types';
import { CommandFactory } from './CommandFactory';
import { DatabaseAdapter } from '../adapters/DatabaseAdapter';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { NextResponse } from 'next/server';

// In-memory storage for commands (fallback when DB is not available)
const commandsStore: Map<string, DbCommand> = new Map();

// Mapa para traducir entre IDs de formato antiguo y UUIDs
const idTranslationMap: Map<string, string> = new Map();

export class CommandService {
  private eventEmitter: EventEmitter;
  
  constructor() {
    this.eventEmitter = new EventEmitter();
  }
  
  /**
   * Submit a command for execution
   */
  async submitCommand(command: CreateCommandParams): Promise<string> {
    try {
      // Try to store command in database using the adapter
      const createdCommand = await DatabaseAdapter.createCommand(command);
      
      // Crear un ID en formato antiguo para compatibilidad
      const legacyId = CommandFactory.generateCommandId();
      
      // Guardar la relación entre el ID de formato antiguo y el UUID
      idTranslationMap.set(legacyId, createdCommand.id);
      // También guardar la relación inversa para facilitar las búsquedas
      idTranslationMap.set(createdCommand.id, createdCommand.id);
      
      // Store command in memory as a fallback (usando el ID antiguo)
      // Añadir el uuid de la BD como metadato para facilitar actualizaciones
      const memoryCommand = { 
        ...createdCommand, 
        id: legacyId,
        // Almacenar el UUID de BD como metadato
        metadata: {
          dbUuid: createdCommand.id,
          createTime: new Date().toISOString()
        }
      };
      commandsStore.set(legacyId, memoryCommand);
      
      // Emit event for command creation with the old ID format but include the DB UUID
      this.eventEmitter.emit('commandCreated', memoryCommand);
      
      console.log(`Command created in database with UUID: ${createdCommand.id}, legacyId: ${legacyId}`);
      
      // Devolver el ID en formato antiguo
      return legacyId;
    } catch (error: any) {
      console.error('Error creating command in database:', error);
      
      // Fallback to in-memory storage if database fails
      console.log('Falling back to in-memory storage...');
      const commandId = CommandFactory.generateCommandId();
      const createdCommand: DbCommand = {
        ...command,
        id: commandId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      // Store command in memory
      commandsStore.set(commandId, createdCommand);
      
      // Emit event for command creation
      this.eventEmitter.emit('commandCreated', createdCommand);
      
      return commandId;
    }
  }
  
  /**
   * Get a command by ID (supports both legacy IDs and UUIDs)
   */
  async getCommandById(commandId: string): Promise<DbCommand | null> {
    try {
      // Verificar si necesitamos traducir el ID
      const dbId = idTranslationMap.get(commandId) || commandId;
      
      // Try to get command from database using the adapter
      const command = await DatabaseAdapter.getCommandById(dbId);
      
      if (command) {
        // Si encontramos el comando, necesitamos devolverlo con el ID solicitado
        const resultCommand = { ...command };
        if (commandId !== dbId) {
          resultCommand.id = commandId; // Usar el ID solicitado (formato antiguo)
        }
        
        // Update memory store with latest data
        commandsStore.set(commandId, resultCommand);
        return resultCommand;
      }
      
      // If not found in database, try memory store
      return commandsStore.get(commandId) || null;
    } catch (error: any) {
      console.error(`Error getting command ${commandId} from database:`, error);
      
      // Fallback to in-memory storage
      return commandsStore.get(commandId) || null;
    }
  }
  
  /**
   * Update the status of a command
   */
  async updateStatus(commandId: string, status: CommandStatus): Promise<DbCommand> {
    try {
      // Traducir el ID si es necesario
      const dbId = idTranslationMap.get(commandId) || commandId;
      
      // Try to update command status in database using the adapter
      await DatabaseAdapter.updateCommandStatus(dbId, status);
      
      // Update in-memory command as well
      const command = commandsStore.get(commandId);
      if (command) {
        command.status = status;
        command.updated_at = new Date().toISOString();
        
        // If the command is completed or failed, calculate duration
        if (status === 'completed' || status === 'failed') {
          const startTime = new Date(command.created_at).getTime();
          const endTime = new Date().getTime();
          command.duration = endTime - startTime;
        }
        
        // Store updated command
        commandsStore.set(commandId, command);
        
        // Emit status change event with dbId information
        this.eventEmitter.emit('statusChange', { 
          id: commandId, 
          dbId, // También incluir el UUID para facilitar actualizaciones
          status 
        });
        
        return { ...command };
      }
      
      throw new Error(`Command not found in memory store: ${commandId}`);
    } catch (error: any) {
      console.error(`Error updating command ${commandId} status in database:`, error);
      
      // Fallback to just updating in-memory command
      const command = commandsStore.get(commandId);
      
      if (!command) {
        throw new Error(`Command not found: ${commandId}`);
      }
      
      // Update command status
      command.status = status;
      command.updated_at = new Date().toISOString();
      
      // If the command is completed or failed, calculate duration
      if (status === 'completed' || status === 'failed') {
        const startTime = new Date(command.created_at).getTime();
        const endTime = new Date().getTime();
        command.duration = endTime - startTime;
      }
      
      // Store updated command
      commandsStore.set(commandId, command);
      
      // Emit status change event with any available database ID
      const dbId = idTranslationMap.get(commandId) || (command.metadata && command.metadata.dbUuid) || commandId;
      this.eventEmitter.emit('statusChange', { 
        id: commandId, 
        dbId, 
        status 
      });
      
      return { ...command };
    }
  }
  
  /**
   * Update a tool's status within a command
   */
  async updateToolStatus(
    commandId: string, 
    toolName: string, 
    status: string, 
    result?: any
  ): Promise<boolean> {
    const command = commandsStore.get(commandId);
    
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
    command.tools = tools;
    command.updated_at = new Date().toISOString();
    
    // Store updated command
    commandsStore.set(commandId, command);
    
    // Emit tool status change event
    this.eventEmitter.emit('toolStatusChange', { 
      commandId, 
      toolName, 
      status 
    });
    
    return true;
  }
  
  /**
   * Update command with results
   */
  async updateCommand(
    commandId: string, 
    updates: Partial<Omit<DbCommand, 'id' | 'created_at' | 'updated_at'>>
  ): Promise<DbCommand> {
    try {
      // Get the database id (UUID) for this command
      const dbId = idTranslationMap.get(commandId) || commandId;
      
      // Update command in database using the adapter
      // Solo intentar actualizar en la BD si el ID es un UUID válido
      let updatedCommand;
      if (DatabaseAdapter.isValidUUID(dbId)) {
        console.log(`Actualizando comando en BD usando UUID: ${dbId}`);
        updatedCommand = await DatabaseAdapter.updateCommand(dbId, updates);
      } else {
        console.warn(`No se puede actualizar en BD con ID no válido: ${dbId}`);
        // Usar el comando en memoria para actualizaciones
        const command = commandsStore.get(commandId);
        if (!command) {
          throw new Error(`Command not found: ${commandId}`);
        }
        
        // Actualizar campos del comando
        updatedCommand = {
          ...command,
          ...updates,
          updated_at: new Date().toISOString()
        };
      }
      
      // Update in-memory copy (preserving metadata if exists)
      const existingCommand = commandsStore.get(commandId) || {} as Partial<DbCommand>;
      const metadata = existingCommand.metadata || {};
      
      const commandToStore = {
        ...updatedCommand,
        id: commandId, // Use the original id for storing
        metadata: {
          ...metadata,
          dbUuid: dbId,
          lastUpdated: new Date().toISOString()
        }
      };
      
      commandsStore.set(commandId, commandToStore);
      
      // Emit command updated event with both IDs
      this.eventEmitter.emit('commandUpdated', {
        ...commandToStore,
        _dbId: dbId  // Include database ID in event data
      });
      
      return commandToStore;
    } catch (error: any) {
      console.error(`Error updating command ${commandId} in database:`, error);
      
      // Fallback to in-memory update only
      const command = commandsStore.get(commandId);
      
      if (!command) {
        throw new Error(`Command not found: ${commandId}`);
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
      
      // Store updated command
      commandsStore.set(commandId, updatedCommand);
      
      // Emit command updated event (include any database ID if available)
      const dbId = idTranslationMap.get(commandId) || (metadata && metadata.dbUuid) || commandId;
      this.eventEmitter.emit('commandUpdated', {
        ...updatedCommand,
        _dbId: dbId  // Include possible database ID
      });
      
      return updatedCommand;
    }
  }
  
  /**
   * Register event listener
   */
  on(event: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.on(event, listener);
  }
  
  /**
   * Remove event listener
   */
  off(event: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.off(event, listener);
  }
  
  /**
   * Update command execution order
   */
  async updateExecutionOrder(commandId: string, executionOrder: string[]): Promise<boolean> {
    try {
      // Update execution order in database
      await DatabaseAdapter.updateCommand(commandId, { execution_order: executionOrder });
      
      // Also update in memory
      const command = commandsStore.get(commandId);
      if (command) {
        command.execution_order = executionOrder;
        command.updated_at = new Date().toISOString();
        commandsStore.set(commandId, command);
      }
      
      return true;
    } catch (error: any) {
      console.error(`Error updating execution order for command ${commandId}:`, error);
      
      // Fallback to memory update only
      const command = commandsStore.get(commandId);
      
      if (!command) {
        return false;
      }
      
      // Update execution order
      command.execution_order = executionOrder;
      command.updated_at = new Date().toISOString();
      
      // Store updated command
      commandsStore.set(commandId, command);
      
      return true;
    }
  }
  
  /**
   * Update command priority
   */
  async updatePriority(commandId: string, priority: number): Promise<boolean> {
    const command = commandsStore.get(commandId);
    
    if (!command) {
      return false;
    }
    
    // Update priority
    command.priority = priority;
    command.updated_at = new Date().toISOString();
    
    // Store updated command
    commandsStore.set(commandId, command);
    
    return true;
  }
  
  /**
   * Request supervision for a command
   */
  async requestSupervision(commandId: string, supervisionRequest: SupervisionRequest): Promise<SupervisionResponse> {
    const command = await this.getCommandById(commandId);
    
    if (!command) {
      throw new Error(`Command not found: ${commandId}`);
    }
    
    // Create supervision request ID
    const requestId = `sup_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    // Emit supervision requested event
    this.eventEmitter.emit('supervisionRequested', {
      requestId,
      commandId,
      supervisionRequest
    });
    
    return {
      requestId,
      status: 'pending',
      commandId
    };
  }
  
  /**
   * Check supervision status
   */
  async checkSupervisionStatus(requestId: string): Promise<SupervisionStatus> {
    // In a real implementation, this would query the database
    // For now, just return pending
    return 'pending';
  }
  
  /**
   * Submit supervision decision
   */
  async submitSupervisionDecision(
    requestId: string, 
    decision: SupervisionDecision
  ): Promise<boolean> {
    // Emit supervision decision event
    this.eventEmitter.emit('supervisionDecision', {
      requestId,
      decision
    });
    
    return true;
  }
  
  /**
   * Get all commands for a user
   */
  async getUserCommands(userId: string): Promise<DbCommand[]> {
    // Filter commands by user ID
    return Array.from(commandsStore.values())
      .filter(command => command.user_id === userId);
  }
  
  /**
   * Get commands by status
   */
  async getCommandsByStatus(status: CommandStatus): Promise<DbCommand[]> {
    // Filter commands by status
    return Array.from(commandsStore.values())
      .filter(command => command.status === status);
  }
  
  /**
   * Delete a command
   */
  async deleteCommand(commandId: string): Promise<boolean> {
    try {
      // Delete from database
      const { error } = await supabaseAdmin
        .from('commands')
        .delete()
        .eq('id', commandId);
      
      if (error) {
        throw error;
      }
      
      // Delete from memory store as well
      const exists = commandsStore.has(commandId);
      if (exists) {
        commandsStore.delete(commandId);
      }
      
      // Emit command deleted event
      this.eventEmitter.emit('commandDeleted', { id: commandId });
      
      return true;
    } catch (error: any) {
      console.error(`Error deleting command ${commandId}:`, error);
      
      // Fallback to just memory store delete
      const exists = commandsStore.has(commandId);
      
      if (exists) {
        commandsStore.delete(commandId);
        
        // Emit command deleted event
        this.eventEmitter.emit('commandDeleted', { id: commandId });
        
        return true;
      }
      
      return false;
    }
  }
  
  /**
   * Calculate command duration
   */
  calculateDuration(startTime: string): number {
    const start = new Date(startTime).getTime();
    const end = new Date().getTime();
    return end - start;
  }
  
  /**
   * Format a command for display
   */
  formatCommandForDisplay(command: DbCommand): any {
    return {
      id: command.id,
      task: command.task,
      status: command.status,
      description: command.description,
      results: command.results,
      created: command.created_at,
      updated: command.updated_at,
      duration: command.duration ? `${(command.duration / 1000).toFixed(2)}s` : null,
      priority: command.priority,
      executionOrder: command.execution_order
    };
  }

  /**
   * Handle command completion and prepare response
   */
  async handleCommandCompletion(commandId: string, dbUuid: string): Promise<NextResponse> {
    try {
      // Get current command state
      const command = await this.getCommandById(commandId);
      
      if (!command) {
        throw new Error(`Command not found: ${commandId}`);
      }
      
      // Update command status to completed
      const updatedCommand = await this.updateStatus(commandId, 'completed');
      
      console.log(`🔄 Estado final del comando: ${updatedCommand.status}`);
      
      // Obtain results if they exist
      const results = updatedCommand.results || [];
      console.log(`📊 Resultados obtenidos (${results.length}): ${JSON.stringify(results.slice(0, 1)).substring(0, 200)}...`);
      
      const messageResults = results.filter((r: any) => r.type === 'message');
      const toolResults = results.filter((r: any) => r.type === 'tool_evaluation');
      
      // Log information about found results
      console.log(`📊 Resultados encontrados: ${results.length} totales, ${messageResults.length} mensajes, ${toolResults.length} evaluaciones de herramientas`);
      
      // Extract response message content
      let responseMessage = 'Command processed successfully';
      if (messageResults.length > 0 && messageResults[0].content) {
        const content = messageResults[0].content;
        responseMessage = typeof content === 'string' 
          ? content 
          : (content.content || responseMessage);
        
        console.log(`💬 Mensaje de respuesta encontrado: ${responseMessage.substring(0, 100)}...`);
      }

      // Return success response with complete information
      return NextResponse.json({
        success: true,
        data: {
          commandId,
          dbUuid,
          status: updatedCommand.status,
          message: responseMessage,
          resultsCount: results.length,
          messageResultsCount: messageResults.length,
          toolResultsCount: toolResults.length,
          completedAt: updatedCommand.updated_at
        }
      });
    } catch (error: any) {
      console.error(`Error handling command completion: ${error.message}`);
      
      // Return an error response
      return NextResponse.json({
        success: false,
        data: {
          commandId,
          dbUuid,
          status: 'failed',
          message: `Error: ${error.message}`,
          error: error.message
        }
      });
    }
  }
} 