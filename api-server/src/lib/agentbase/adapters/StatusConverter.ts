/**
 * Conversor de estados entre Agentbase y la Base de datos
 */

import {
  CommandStatus as AgentbaseCommandStatus
} from '../models/types';

import {
  CommandStatus as DbCommandStatus
} from '@/lib/database/command-db';

/**
 * Clase para convertir estados entre Agentbase y la base de datos
 */
export class StatusConverter {
  /**
   * Convierte un estado de comando de Agentbase a formato de BD
   */
  static toDbFormat(status: AgentbaseCommandStatus): DbCommandStatus {
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
  static toAgentbaseFormat(status: DbCommandStatus): AgentbaseCommandStatus {
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
} 