/**
 * Database Adapter for Agentbase
 * 
 * Simplificado para usar directamente el formato de la base de datos.
 */

import { 
  DbCommand,
  CommandStatus,
  CreateCommandParams
} from '../models/types';

import { CommandService } from './CommandService';
import { CommandUpdateService } from './CommandUpdateService';
import { AgentService } from './AgentService';

// Función para verificar si una cadena es un UUID válido
function isValidUUID(uuid: string): boolean {
  if (!uuid) return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Adaptador para operaciones de base de datos
 */
export class DatabaseAdapter {
  /**
   * Verifica si una cadena es un UUID válido
   */
  static isValidUUID(uuid: string): boolean {
    return isValidUUID(uuid);
  }
  
  /**
   * Crea un comando en la base de datos
   */
  static async createCommand(command: CreateCommandParams): Promise<DbCommand> {
    return CommandService.createCommand(command);
  }
  
  /**
   * Obtiene un comando por ID
   */
  static async getCommandById(commandId: string): Promise<DbCommand | null> {
    return CommandService.getCommandById(commandId);
  }
  
  /**
   * Actualiza el estado de un comando
   */
  static async updateCommandStatus(commandId: string, status: CommandStatus): Promise<boolean> {
    return CommandService.updateCommandStatus(commandId, status);
  }
  
  /**
   * Actualiza un comando
   */
  static async updateCommand(
    commandId: string,
    updates: Partial<Omit<DbCommand, 'id' | 'created_at' | 'updated_at'>>
  ): Promise<DbCommand> {
    return CommandUpdateService.updateCommand(commandId, updates);
  }

  /**
   * Verifica explícitamente si un comando tiene agent_background en la base de datos
   */
  static async verifyAgentBackground(commandId: string): Promise<{ hasBackground: boolean, value: string | null }> {
    console.log(`🔍 [DatabaseAdapter] Verificando agent_background para ${commandId}`);
    
    // 1. Primero buscar en CommandCache (fuente más directa)
    try {
      const { CommandCache } = require('../services/command/CommandCache');
      const cachedCommand = CommandCache.getCachedCommand(commandId);
      
      if (cachedCommand && cachedCommand.agent_background) {
        return {
          hasBackground: true,
          value: cachedCommand.agent_background
        };
      }
    } catch (error) {
      // Ignorar errores de caché
    }
    
    // 2. Si no está en caché, buscar directamente en la base de datos
    try {
      const command = await this.getCommandById(commandId);
      
      if (command && command.agent_background) {
        return {
          hasBackground: true,
          value: command.agent_background
        };
      }
    } catch (error) {
      // Ignorar errores y devolver que no se encontró
    }
    
    return { hasBackground: false, value: null };
  }

  /**
   * Obtener información completa del agente desde la base de datos
   */
  static async getAgentById(agentId: string): Promise<any | null> {
    console.log(`🔍 [DatabaseAdapter] Obteniendo información del agente ${agentId}`);
    return AgentService.getAgentById(agentId);
  }

  /**
   * Obtener los archivos asociados a un agente desde la base de datos
   */
  static async getAgentFiles(agentId: string): Promise<any[] | null> {
    console.log(`🔍 [DatabaseAdapter] Obteniendo archivos del agente ${agentId}`);
    return AgentService.getAgentFiles(agentId);
  }

  /**
   * Leer el contenido de un archivo del agente desde el sistema de almacenamiento
   */
  static async getAgentFileContent(filePath: string): Promise<string | null> {
    console.log(`🔍 [DatabaseAdapter] Leyendo contenido del archivo ${filePath}`);
    return AgentService.getAgentFileContent(filePath);
  }
  
  /**
   * Obtener información completa de un sitio desde la base de datos
   */
  static async getSiteById(siteId: string): Promise<any | null> {
    console.log(`🔍 [DatabaseAdapter] Obteniendo información del sitio ${siteId}`);
    return AgentService.getSiteById(siteId);
  }
  
  /**
   * Obtener configuración completa de un sitio desde la base de datos
   */
  static async getSiteSettingsById(siteId: string): Promise<any | null> {
    console.log(`🔍 [DatabaseAdapter] Obteniendo configuración del sitio ${siteId}`);
    return AgentService.getSiteSettingsById(siteId);
  }

  /**
   * Obtener copywriting de un sitio desde la base de datos
   */
  static async getCopywritingBySiteId(siteId: string): Promise<any[] | null> {
    console.log(`🔍 [DatabaseAdapter] Obteniendo copywriting del sitio ${siteId}`);
    return AgentService.getCopywritingBySiteId(siteId);
  }
} 