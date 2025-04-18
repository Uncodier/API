/**
 * SupervisionService - Servicio para gestionar la supervisión de comandos
 */
import { 
  SupervisionRequest, 
  SupervisionResponse, 
  SupervisionStatus, 
  SupervisionDecision 
} from '../models/types';
import { CommandStore } from './command/CommandStore';
import { EventEmitter } from 'events';

export class SupervisionService {
  private eventEmitter: EventEmitter;

  constructor(eventEmitter: EventEmitter) {
    this.eventEmitter = eventEmitter;
  }

  /**
   * Solicita supervisión para un comando
   * 
   * @param commandId ID del comando
   * @param supervisionRequest Solicitud de supervisión
   * @returns Respuesta de supervisión
   */
  async requestSupervision(commandId: string, supervisionRequest: SupervisionRequest): Promise<SupervisionResponse> {
    const command = CommandStore.getCommand(commandId);
    
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
   * Verifica el estado de una solicitud de supervisión
   * 
   * @param requestId ID de la solicitud
   * @returns Estado de la supervisión
   */
  async checkSupervisionStatus(requestId: string): Promise<SupervisionStatus> {
    // In a real implementation, this would query the database
    // For now, just return pending
    return 'pending';
  }

  /**
   * Envía una decisión de supervisión
   * 
   * @param requestId ID de la solicitud
   * @param decision Decisión de supervisión
   * @returns true si se realizó con éxito, false si no
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
} 