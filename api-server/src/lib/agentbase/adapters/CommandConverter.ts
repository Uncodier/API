/**
 * Conversor de comandos entre Agentbase y la Base de datos
 */

import {
  DbCommand as AgentbaseDbCommand,
  CreateCommandParams as AgentbaseCreateCommandParams,
  CommandStatus
} from '../models/types';

import {
  DbCommand as DbCommandModel,
  CreateCommandParams as DbCreateCommandParams
} from '@/lib/database/command-db';

import { StatusConverter } from './StatusConverter';
import { generateUUID, isValidUUID } from '../utils/UuidUtils';
import { ensureTargetContentExists } from '../utils/DataFormatUtils';

/**
 * Clase para la conversión de comandos entre formatos Agentbase y BD
 */
export class CommandConverter {
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
      dbCommand.status = StatusConverter.toDbFormat(command.status);
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
    } else if (command.model_id !== undefined && command.model_id !== null) {
      // Si no hay model pero sí hay model_id, usamos el model_id como model para guardar en la BD
      dbCommand.model = command.model_id;
    }
    
    // Añadir model_type si está definido - solo en caché, no en BD
    if (command.model_type !== undefined && command.model_type !== null) {
      // No lo guardamos en la BD ya que no existe la columna
      // Solo se usará internamente en el objeto en memoria
    }
    
    // Añadir model_id si está definido
    if (command.model_id !== undefined && command.model_id !== null) {
      (dbCommand as any).model_id = command.model_id;
    }
    
    // Solo incluir agent_id si es un UUID válido
    if (command.agent_id && isValidUUID(command.agent_id)) {
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
   * Convierte un comando de base de datos a formato Agentbase
   */
  static toAgentbaseFormat(dbCommand: DbCommandModel): AgentbaseDbCommand {
    console.log(`Convirtiendo comando de DB a formato Agentbase: ${JSON.stringify({
      id: dbCommand.id,
      task: dbCommand.task,
      status: dbCommand.status,
      agent_id: dbCommand.agent_id
    })}`);
    
    // Check if agent_background exists and log
    if ((dbCommand as any).agent_background) {
      console.log(`🔍 Comando ${dbCommand.id} tiene agent_background de longitud: ${(dbCommand as any).agent_background.length}`);
    } else {
      console.log(`🔍 Comando ${dbCommand.id} NO TIENE agent_background`);
    }
    
    // Extraer el agentId original del contexto si existe y no tiene un agent_id válido
    let originalAgentId = dbCommand.agent_id;
    if ((!originalAgentId || !isValidUUID(originalAgentId)) && dbCommand.context) {
      const match = dbCommand.context.match(/Original Agent ID: (.+)$/m);
      if (match && match[1]) {
        originalAgentId = match[1];
        console.log(`Recuperado Original Agent ID desde contexto: ${originalAgentId}`);
      }
    }
    
    // Asegurarnos de que los targets tengan siempre content, aunque sea null
    const processedTargets = dbCommand.targets ? ensureTargetContentExists(dbCommand.targets) : [];
    
    // Crear el comando en formato Agentbase incluyendo explícitamente agent_background
    const agentbaseCommand: AgentbaseDbCommand = {
      id: dbCommand.id,
      task: dbCommand.task,
      status: dbCommand.status as CommandStatus,
      description: dbCommand.description || '',
      user_id: dbCommand.user_id,
      results: dbCommand.results || [],
      targets: processedTargets,
      tools: dbCommand.tools || [],
      functions: dbCommand.functions || [],
      context: dbCommand.context || '',
      created_at: dbCommand.created_at || new Date().toISOString(),
      updated_at: dbCommand.updated_at || new Date().toISOString(),
      agent_id: originalAgentId || dbCommand.agent_id || undefined,
      model: dbCommand.model || undefined,
      model_type: (dbCommand as any).model_type || undefined,
      model_id: (dbCommand as any).model_id || dbCommand.model || undefined,
      agent_background: (dbCommand as any).agent_background || undefined,
      input_tokens: dbCommand.input_tokens !== null ? dbCommand.input_tokens : undefined,
      output_tokens: dbCommand.output_tokens !== null ? dbCommand.output_tokens : undefined,
      site_id: dbCommand.site_id || undefined
    };
    
    // Log de información de modelo para depuración
    console.log(`🔍 [CommandConverter] Información de modelo en la conversión:
      dbCommand.model: ${dbCommand.model || 'undefined'}
      (dbCommand as any).model_id: ${(dbCommand as any).model_id || 'undefined'}
      (dbCommand as any).model_type: ${(dbCommand as any).model_type || 'undefined'}
      Resultado final:
      model: ${agentbaseCommand.model || 'undefined'}
      model_id: ${agentbaseCommand.model_id || 'undefined'}
      model_type: ${agentbaseCommand.model_type || 'undefined'}
    `);
    
    // Si hay propiedades adicionales en dbCommand que no están en el tipo AgentbaseDbCommand, 
    // las manejamos por separado (por ejemplo, completion_date y duration)
    if (dbCommand.completion_date) {
      (agentbaseCommand as any).completion_date = dbCommand.completion_date;
    }
    
    if (dbCommand.duration !== undefined && dbCommand.duration !== null) {
      (agentbaseCommand as any).duration = dbCommand.duration;
    }
    
    // Verificar que el agent_background se haya transferido correctamente
    if ((dbCommand as any).agent_background && !agentbaseCommand.agent_background) {
      console.error(`❌ Error crítico: agent_background se perdió durante la conversión del comando ${dbCommand.id}`);
    } else if ((dbCommand as any).agent_background && agentbaseCommand.agent_background) {
      console.log(`✅ agent_background preservado durante la conversión (${agentbaseCommand.agent_background.length} caracteres)`);
    }
    
    return agentbaseCommand;
  }
} 