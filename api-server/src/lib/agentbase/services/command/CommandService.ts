/**
 * Command Service for managing command lifecycle
 * 
 * Este servicio ha sido modificado para preservar el campo agent_background
 * directamente sin conversiones de formato innecesarias.
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
} from '../../models/types';
import { CommandStore } from './CommandStore';
import { CommandSubmitService } from './CommandSubmitService';
import { CommandUpdateService } from './CommandUpdateService';
import { CommandQueryService } from './CommandQueryService';
import { CommandStatusService } from './CommandStatusService';
import { CommandResultService } from './CommandResultService';
import { SupervisionService } from '../SupervisionService';
import { NextResponse } from 'next/server';

export class CommandService {
  private eventEmitter: EventEmitter;
  private commandSubmitService: CommandSubmitService;
  private commandQueryService: CommandQueryService;
  private commandStatusService: CommandStatusService;
  private commandResultService: CommandResultService;
  private commandUpdateService: CommandUpdateService;
  private supervisionService: SupervisionService;
  
  constructor() {
    // Inicializar event emitter
    this.eventEmitter = new EventEmitter();
    
    // Configurar el eventEmitter en CommandStore para eventos globales
    CommandStore.setEventEmitter(this.eventEmitter);
    
    // Inicializar los servicios con el eventEmitter compartido
    this.commandSubmitService = new CommandSubmitService(this.eventEmitter);
    this.commandQueryService = new CommandQueryService(this.eventEmitter);
    this.commandUpdateService = new CommandUpdateService(this.eventEmitter);
    this.commandStatusService = new CommandStatusService(this.eventEmitter);
    this.commandResultService = new CommandResultService();
    this.supervisionService = new SupervisionService(this.eventEmitter);
    
    console.log('✅ CommandService iniciado con todos los subservicios');
  }
  
  /**
   * Register event listener
   */
  on(event: string, listener: (...args: any[]) => void): this {
    this.eventEmitter.on(event, listener);
    return this;
  }
  
  /**
   * Submit a command for execution
   */
  async submitCommand(command: CreateCommandParams): Promise<string> {
    console.log('🔄 [CommandService] Enviando comando para ejecución');
    
    // Verificar si hay agent_background y registrarlo
    if (command.agent_background) {
      console.log(`✅ [CommandService] Command tiene agent_background (${command.agent_background.length} caracteres)`);
    } else {
      console.log(`⚠️ [CommandService] Command NO tiene agent_background`);
    }
    
    // Enviar comando para ejecución
    return this.commandSubmitService.submitCommand(command);
  }
  
  /**
   * Get a command by ID (supports both legacy IDs and UUIDs)
   */
  async getCommandById(commandId: string): Promise<DbCommand | null> {
    console.log(`🔍 [CommandService] Obteniendo comando: ${commandId}`);
    const command = await this.commandQueryService.getCommandById(commandId);
    
    // Verificar si el comando recuperado tiene agent_background
    if (command && command.agent_background) {
      console.log(`✅ [CommandService] Comando recuperado tiene agent_background (${command.agent_background.length} caracteres)`);
    } else if (command) {
      console.log(`⚠️ [CommandService] Comando recuperado NO tiene agent_background`);
    }
    
    return command;
  }
  
  /**
   * Update command status
   * 
   * @param commandId Command ID
   * @param status New status
   * @param errorMessage Optional error message when status is failed
   * @returns Promise<DbCommand | null> Updated command or null if not found
   */
  async updateStatus(commandId: string, status: CommandStatus, errorMessage?: string): Promise<DbCommand | null> {
    console.log(`🔄 [CommandService] Actualizando estado a ${status} para: ${commandId}`);
    
    // Si hay error, preservar el agent_background al actualizar
    if (errorMessage && status === 'failed') {
      // Obtener el comando actual para preservar su agent_background
      try {
        const currentCommand = await this.getCommandById(commandId);
        if (currentCommand && currentCommand.agent_background) {
          console.log(`🔍 [CommandService] Comando a actualizar tiene agent_background, preservándolo durante actualización de estado`);
          // Preservar explícitamente el agent_background al actualizar estado
          await this.updateCommand(commandId, {
            agent_background: currentCommand.agent_background,
            error: errorMessage
          });
        }
      } catch (error) {
        console.error(`❌ [CommandService] Error al preservar agent_background durante actualización de estado:`, error);
      }
    }
    
    return this.commandStatusService.updateStatus(commandId, status, errorMessage);
  }
  
  /**
   * Update command with results
   */
  async updateCommand(
    commandId: string, 
    updates: Partial<Omit<DbCommand, 'id' | 'created_at' | 'updated_at'>>
  ): Promise<DbCommand> {
    console.log(`🔄 [CommandService] Actualizando comando: ${commandId}`);
    
    // Verificar si estamos actualizando el agent_background
    if (updates.agent_background) {
      console.log(`✅ [CommandService] Actualizando agent_background (${updates.agent_background.length} caracteres)`);
    }
    
    return this.commandUpdateService.updateCommand(commandId, updates);
  }
  
  /**
   * Update command results
   * 
   * @param commandId Command ID
   * @param results Array of results to add to the command
   * @returns Promise<DbCommand | null> Updated command or null if not found
   */
  async updateResults(commandId: string, results: any[]): Promise<DbCommand | null> {
    console.log(`🔄 [CommandService] Actualizando resultados para: ${commandId}`);
    return this.commandResultService.updateResults(commandId, results);
  }
  
  /**
   * Remove event listener
   */
  off(event: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.off(event, listener);
  }
  
  /**
   * Get user commands
   */
  async getUserCommands(userId: string): Promise<DbCommand[]> {
    return this.commandQueryService.getUserCommands(userId);
  }
  
  /**
   * Format a command for display
   */
  formatCommandForDisplay(command: DbCommand): any {
    return this.commandSubmitService.formatCommandForDisplay(command);
  }

  /**
   * Handle command completion and prepare response
   */
  async handleCommandCompletion(commandId: string, dbUuid: string): Promise<NextResponse> {
    return this.commandResultService.handleCommandCompletion(commandId, dbUuid);
  }

  /**
   * Obtiene el emisor de eventos para uso externo
   */
  public getEventEmitter(): EventEmitter {
    return this.eventEmitter;
  }
} 