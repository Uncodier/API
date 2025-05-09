/**
 * Servicios para la gestión de comandos
 */

import {
  DbCommand as AgentbaseDbCommand,
  CreateCommandParams as AgentbaseCreateCommandParams,
  CommandStatus as AgentbaseCommandStatus
} from '../models/types';

import {
  DbCommand as DbCommandModel,
  createCommand as dbCreateCommand, 
  updateCommand as dbUpdateCommand,
  updateCommandStatus as dbUpdateCommandStatus,
  getCommandById as dbGetCommandById
} from '@/lib/database/command-db';

import { CommandConverter } from './CommandConverter';
import { StatusConverter } from './StatusConverter';
import { isValidUUID } from '../utils/UuidUtils';
import { extractConversationId } from '../utils/DataFormatUtils';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Clase para gestionar operaciones con comandos
 */
export class CommandService {
  /**
   * Crea un comando en la base de datos
   */
  static async createCommand(command: AgentbaseCreateCommandParams): Promise<AgentbaseDbCommand> {
    try {
      console.log("Iniciando creación de comando en BD:", JSON.stringify({
        task: command.task,
        agent_id: command.agent_id
      }));
      
      const dbCommandData = CommandConverter.toDbFormat(command);
      
      console.log("Enviando comando a BD:", JSON.stringify(dbCommandData));
      
      const dbCommand = await dbCreateCommand(dbCommandData);
      
      console.log(`Comando guardado en BD con UUID: ${dbCommand.id}`);
      
      return CommandConverter.toAgentbaseFormat(dbCommand);
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
      if (isValidUUID(commandId)) {
        console.log(`ID ${commandId} es un UUID válido, buscando en BD`);
        const dbCommand = await dbGetCommandById(commandId);
        
        if (dbCommand) {
          console.log(`Comando encontrado en BD: ${commandId}`);
          return CommandConverter.toAgentbaseFormat(dbCommand);
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
      if (isValidUUID(commandId)) {
        console.log(`ID ${commandId} es un UUID válido, actualizando en BD`);
        return await dbUpdateCommandStatus(commandId, StatusConverter.toDbFormat(status));
      } else {
        console.log(`ID no es un UUID válido, no se actualizará en BD: ${commandId}`);
        return false;
      }
    } catch (error) {
      console.error(`Error updating status for command ${commandId}:`, error);
      return false;
    }
  }
} 