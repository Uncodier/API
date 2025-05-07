import { CommandFactory } from '@/lib/agentbase/services/command/CommandFactory';
import { ProcessorInitializer } from '@/lib/agentbase';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { v4 as uuidv4 } from 'uuid';

/**
 * Servicio para interactuar con agentes, comandos y el sistema de procesamiento
 */
export class AgentService {
  private static processorInitializer = ProcessorInitializer.getInstance();
  private static commandService = AgentService.processorInitializer.getCommandService();

  /**
   * Inicializa el sistema de procesamiento de agentes
   */
  public static initialize(): void {
    AgentService.processorInitializer.initialize();
  }

  /**
   * Busca un agente apropiado para el sitio especificado
   * @param site_id ID del sitio
   * @param agentId ID del agente (opcional)
   * @param type Tipo de agente a buscar (por defecto: 'cmo')
   * @returns ID del agente efectivo o null si no se encuentra
   */
  public static async findEffectiveAgent(
    site_id: string, 
    agentId?: string, 
    type: string = 'cmo'
  ): Promise<string | null> {
    // Si ya tenemos un agentId, verificar si existe
    if (agentId) {
      try {
        const { data: agentExists, error: agentCheckError } = await supabaseAdmin
          .from('agents')
          .select('id')
          .eq('id', agentId)
          .single();
          
        if (!agentCheckError && agentExists) {
          console.log(`✅ Agente con ID ${agentId} verificado en la base de datos`);
          return agentId;
        }
      } catch (verifyError) {
        console.error('Error al verificar agente:', verifyError);
      }
    }
    
    // Buscar un agente para el site_id proporcionado
    try {
      // Búsqueda específica por tipo
      const { data: siteAgentData, error: siteAgentError } = await supabaseAdmin
        .from('agents')
        .select('id')
        .eq('site_id', site_id)
        .eq('type', type)
        .order('created_at', { ascending: false })
        .limit(1);
        
      if (!siteAgentError && siteAgentData && siteAgentData.length > 0) {
        console.log(`🔍 Agente ${type} encontrado para site_id ${site_id}: ${siteAgentData[0].id}`);
        return siteAgentData[0].id;
      }
      
      // Si no se encuentra un agente del tipo específico, buscar cualquier agente del sitio
      const { data: anyAgentData, error: anyAgentError } = await supabaseAdmin
        .from('agents')
        .select('id')
        .eq('site_id', site_id)
        .order('created_at', { ascending: false })
        .limit(1);
        
      if (!anyAgentError && anyAgentData && anyAgentData.length > 0) {
        console.log(`🔍 Agente genérico encontrado para site_id ${site_id}: ${anyAgentData[0].id}`);
        return anyAgentData[0].id;
      }
      
      // Búsqueda de agente por defecto solo si es necesario
      const { data: defaultAgentData, error: defaultAgentError } = await supabaseAdmin
        .from('agents')
        .select('id')
        .eq('type', type)
        .limit(1);
        
      if (!defaultAgentError && defaultAgentData && defaultAgentData.length > 0) {
        console.log(`🔍 Agente por defecto encontrado: ${defaultAgentData[0].id}`);
        return defaultAgentData[0].id;
      }
    } catch (error) {
      console.error('Error al buscar agente:', error);
    }
    
    // Si no se encuentra ningún agente, retornar null
    return null;
  }

  /**
   * Crea y envía un comando al sistema de procesamiento
   * @param commandData Datos del comando a crear
   * @returns ID interno del comando
   */
  public static async submitCommand(commandData: any): Promise<string> {
    const command = CommandFactory.createCommand(commandData);
    return await AgentService.commandService.submitCommand(command);
  }

  /**
   * Crea un comando sin asociación con un agente
   * @param commandData Datos del comando (sin agentId)
   * @returns ID interno del comando
   */
  public static async createCommandWithoutAgent(commandData: any): Promise<string> {
    try {
      // Filtrar campos para eliminar agentId si está presente
      const { agentId, ...commandWithoutAgent } = commandData;
      
      // Crear comando utilizando CommandFactory sin agentId
      const command = CommandFactory.createCommand(commandWithoutAgent);
      
      // Enviar el comando para su procesamiento
      return await AgentService.commandService.submitCommand(command);
    } catch (error) {
      console.error('Error al crear comando sin agente:', error);
      throw error;
    }
  }

  /**
   * Obtiene el UUID del comando en la base de datos
   * @param internalId ID interno del comando
   * @returns UUID del comando en la base de datos o null si no se encuentra
   */
  public static async getCommandDbUuid(internalId: string): Promise<string | null> {
    try {
      // Intentar obtener el comando
      const command = await AgentService.commandService.getCommandById(internalId);
      
      // Verificar metadata
      if (command && command.metadata && command.metadata.dbUuid) {
        if (AgentService.isValidUUID(command.metadata.dbUuid)) {
          console.log(`🔑 UUID encontrado en metadata: ${command.metadata.dbUuid}`);
          return command.metadata.dbUuid;
        }
      }
      
      // Buscar en el mapa de traducción interno del CommandService
      try {
        // @ts-ignore - Accediendo a propiedades internas
        const idMap = (AgentService.commandService as any).idTranslationMap;
        if (idMap && idMap.get && idMap.get(internalId)) {
          const mappedId = idMap.get(internalId);
          if (AgentService.isValidUUID(mappedId)) {
            console.log(`🔑 UUID encontrado en mapa interno: ${mappedId}`);
            return mappedId;
          }
        }
      } catch (err) {
        console.log('No se pudo acceder al mapa de traducción interno');
      }
      
      // Buscar en la base de datos directamente por algún campo que pueda relacionarse
      if (command) {
        const { data, error } = await supabaseAdmin
          .from('commands')
          .select('id')
          .eq('task', command.task)
          .eq('user_id', command.user_id)
          .eq('status', command.status)
          .order('created_at', { ascending: false })
          .limit(1);
        
        if (!error && data && data.length > 0) {
          console.log(`🔑 UUID encontrado en búsqueda directa: ${data[0].id}`);
          return data[0].id;
        }
      }
      
      return null;
    } catch (error) {
      console.error('Error al obtener UUID de base de datos:', error);
      return null;
    }
  }

  /**
   * Verifica si un string es un UUID válido
   * @param uuid String a verificar
   * @returns true si es un UUID válido, false en caso contrario
   */
  public static isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  /**
   * Espera a que un comando se complete
   * @param commandId ID del comando
   * @param maxAttempts Número máximo de intentos
   * @param delayMs Tiempo de espera entre intentos en milisegundos
   * @returns Información sobre el comando, su UUID en la BD y si se completó
   */
  public static async waitForCommandCompletion(
    commandId: string, 
    maxAttempts = 120, 
    delayMs = 1000
  ): Promise<{command: any, dbUuid: string | null, completed: boolean}> {
    let executedCommand = null;
    let attempts = 0;
    let dbUuid: string | null = null;
    let lastStatus: string | null = null;
    
    console.log(`⏳ Esperando a que se complete el comando ${commandId}...`);
    
    // Crear una promesa que se resuelve cuando el comando se completa o se agota el tiempo
    return new Promise<{command: any, dbUuid: string | null, completed: boolean}>((resolve) => {
      const checkInterval = setInterval(async () => {
        attempts++;
        
        try {
          executedCommand = await AgentService.commandService.getCommandById(commandId);
          
          if (!executedCommand) {
            console.log(`⚠️ No se pudo encontrar el comando ${commandId}`);
            clearInterval(checkInterval);
            resolve({command: null, dbUuid: null, completed: false});
            return;
          }

          // Registrar si el comando tiene agent_background
          if (executedCommand.agent_background) {
            console.log(`✅ El comando ${commandId} tiene agent_background (${executedCommand.agent_background.length} caracteres)`);
          } else {
            console.log(`⚠️ El comando ${commandId} NO tiene agent_background en este intento ${attempts}`);
          }
          
          // Guardar el UUID de la base de datos si está disponible
          if (executedCommand.metadata && executedCommand.metadata.dbUuid) {
            dbUuid = executedCommand.metadata.dbUuid as string;
            console.log(`🔑 UUID de base de datos encontrado en metadata: ${dbUuid}`);
          }

          // Detectar si el estado ha cambiado desde la última comprobación
          if (lastStatus !== executedCommand.status) {
            console.log(`🔄 Estado del comando cambió: ${lastStatus || 'desconocido'} -> ${executedCommand.status}`);
            lastStatus = executedCommand.status;
          } else if (attempts % 10 === 0) {
            // Cada 10 intentos sin cambio de estado, mostrar mensaje adicional
            console.log(`⚠️ El comando ${commandId} permanece en estado '${executedCommand.status}' después de ${attempts} intentos`);
          }
          
          // Verificar si el comando falló explícitamente
          if (executedCommand.status === 'failed') {
            console.log(`❌ El comando ${commandId} falló con estado: failed`);
            console.log(`❌ Error: ${executedCommand.error || 'No hay detalles del error'}`);
            
            // Intentar obtener el UUID de la base de datos si aún no lo tenemos
            if (!dbUuid || !AgentService.isValidUUID(dbUuid)) {
              dbUuid = await AgentService.getCommandDbUuid(commandId);
              console.log(`🔍 UUID obtenido después de fallo: ${dbUuid || 'No encontrado'}`);
            }
            
            clearInterval(checkInterval);
            resolve({command: executedCommand, dbUuid, completed: false});
            return;
          }
          
          // Comprobar si el comando se ha completado basado en su estado - solo consideramos 'completed'
          const isStatusCompleted = executedCommand.status === 'completed';
          
          // Si el estado es completed, considerar el comando como completado
          if (isStatusCompleted) {
            console.log(`✅ Comando ${commandId} completado con estado: ${executedCommand.status}`);
            
            // Intentar obtener el UUID de la base de datos si aún no lo tenemos
            if (!dbUuid || !AgentService.isValidUUID(dbUuid)) {
              dbUuid = await AgentService.getCommandDbUuid(commandId);
              console.log(`🔍 UUID obtenido después de completar: ${dbUuid || 'No encontrado'}`);
            }
            
            clearInterval(checkInterval);
            resolve({command: executedCommand, dbUuid, completed: true});
            return;
          }
          
          console.log(`⏳ Comando ${commandId} aún en ejecución (estado: ${executedCommand.status}), intento ${attempts}/${maxAttempts}`);
          
          if (attempts >= maxAttempts) {
            console.log(`⏰ Tiempo de espera agotado para el comando ${commandId} después de ${maxAttempts} intentos`);
            console.log(`⚠️ Estado final del comando: ${executedCommand.status}`);
            
            // Último intento de obtener el UUID
            if (!dbUuid || !AgentService.isValidUUID(dbUuid)) {
              dbUuid = await AgentService.getCommandDbUuid(commandId);
              console.log(`🔍 UUID obtenido antes de timeout: ${dbUuid || 'No encontrado'}`);
            }
            
            clearInterval(checkInterval);
            resolve({command: executedCommand, dbUuid, completed: false});
          }
        } catch (error) {
          console.error(`Error al verificar estado del comando ${commandId}:`, error);
          clearInterval(checkInterval);
          resolve({command: null, dbUuid: null, completed: false});
        }
      }, delayMs);
    });
  }
} 