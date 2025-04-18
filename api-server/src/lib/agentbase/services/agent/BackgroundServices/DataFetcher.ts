/**
 * DataFetcher.ts
 * Clase para obtener y gestionar los datos de un agente desde diferentes fuentes
 */
import { Base } from '../../../agents/Base';
import { AgentCacheService } from '../AgentCacheService';
import { DatabaseAdapter } from '../../../adapters/DatabaseAdapter';
import { CapabilitiesExtractor } from './CapabilitiesExtractor';
import { CommandCache } from '../../command/CommandCache';

export class DataFetcher {
  private static agentCache = AgentCacheService.getInstance();
  
  /**
   * Obtiene los datos de un agente desde caché y base de datos
   * @param agentId ID del agente
   * @param processor Procesador base
   * @returns Objeto con los datos del agente encontrados
   */
  public static async getAgentData(agentId: string, processor: Base): Promise<{
    name: string;
    description: string;
    backstory: string;
    systemPrompt: string;
    agentPrompt: string;
    capabilities: string[];
    files?: any[];
  }> {
    console.log(`🔍 [DataFetcher] Buscando datos para agente: ${agentId}`);
    
    // Valores por defecto
    const defaultData = {
      name: processor.getName(),
      description: '',
      backstory: '',
      systemPrompt: '',
      agentPrompt: '',
      capabilities: [],
      files: []
    };
    
    // Si no es un UUID válido, retornar valores por defecto
    if (!agentId || !DatabaseAdapter.isValidUUID(agentId)) {
      console.log(`🧠 [DataFetcher] agentId no es válido: ${agentId}, usando información por defecto`);
      return defaultData;
    }
    
    // Buscar en caché primero
    try {
      console.log(`🔍 [DataFetcher] Buscando en caché para el agente: ${agentId}`);
      const cacheResult = await this.agentCache.getAgentData(agentId);
      
      if (cacheResult) {
        console.log(`✅ [DataFetcher] Encontrada información en caché para el agente: ${agentId}`);
        return this.extractDataFromAgentObject(cacheResult.agentData, processor);
      }
    } catch (cacheError) {
      console.error(`❌ [DataFetcher] Error al buscar en caché:`, cacheError);
    }
    
    // Si no se encontró en caché, buscar en base de datos
    try {
      console.log(`🔍 [DataFetcher] Buscando en base de datos para el agente: ${agentId}`);
      const agentData = await DatabaseAdapter.getAgentById(agentId);
      
      if (agentData) {
        console.log(`✅ [DataFetcher] Encontrada información en base de datos para el agente: ${agentId}`);
        
        // Obtener los archivos del agente
        try {
          const agentFiles = await DatabaseAdapter.getAgentFiles(agentId);
          if (agentFiles && agentFiles.length > 0) {
            console.log(`✅ [DataFetcher] Encontrados ${agentFiles.length} archivos para el agente: ${agentId}`);
            agentData.files = agentFiles;
          }
        } catch (filesError) {
          console.error(`❌ [DataFetcher] Error al obtener archivos:`, filesError);
        }
        
        // Guardar en caché para futuras consultas
        this.agentCache.setAgentData(agentId, agentData);
        console.log(`✅ [DataFetcher] Información del agente guardada en caché: ${agentId}`);
        
        return this.extractDataFromAgentObject(agentData, processor);
      }
    } catch (dbError) {
      console.error(`❌ [DataFetcher] Error al obtener información desde la base de datos:`, dbError);
    }
    
    console.log(`🔍 [DataFetcher] No se encontró información para el agente: ${agentId}`);
    return defaultData;
  }
  
  /**
   * Extrae los datos relevantes de un objeto de agente
   */
  private static extractDataFromAgentObject(agentData: any, processor: Base): any {
    const config = agentData.configuration || {};
    const result = {
      name: agentData.name || processor.getName(),
      description: '',
      backstory: '',
      systemPrompt: '',
      agentPrompt: '',
      capabilities: [] as string[],
      files: agentData.files || []
    };
    
    // Extraer backstory
    if (config.backstory) {
      console.log(`🧠 [DataFetcher] Encontrado backstory en config (${config.backstory.length} caracteres)`);
      result.backstory = config.backstory;
    } else if (agentData.backstory) {
      console.log(`🧠 [DataFetcher] Encontrado backstory en agentData (${agentData.backstory.length} caracteres)`);
      result.backstory = agentData.backstory;
    }
    
    // Extraer systemPrompt
    if (config.systemPrompt) {
      console.log(`🧠 [DataFetcher] Encontrado systemPrompt (${config.systemPrompt.length} caracteres)`);
      result.systemPrompt = config.systemPrompt;
    }
    
    // Extraer prompt específico
    if (config.prompt) {
      console.log(`🧠 [DataFetcher] Encontrado prompt en config (${config.prompt.length} caracteres)`);
      result.agentPrompt = config.prompt;
    } else if (agentData.prompt) {
      console.log(`🧠 [DataFetcher] Encontrado prompt en agentData (${agentData.prompt.length} caracteres)`);
      result.agentPrompt = agentData.prompt;
    }
    
    // Extraer descripción
    if (config.description) {
      console.log(`🧠 [DataFetcher] Encontrada descripción en config`);
      result.description = config.description;
    } else if (agentData.description) {
      console.log(`🧠 [DataFetcher] Encontrada descripción en agentData`);
      result.description = agentData.description;
    }
    
    // Extraer capabilities
    if (agentData.tools && Array.isArray(agentData.tools) && agentData.tools.length > 0) {
      result.capabilities = CapabilitiesExtractor.extractCapabilitiesFromTools(
        agentData.tools, 
        `tools para el agente ${agentData.id || 'desconocido'}`
      );
    } else if (config.capabilities) {
      console.log(`🧠 [DataFetcher] Usando capabilities de config`);
      result.capabilities = config.capabilities;
    } else if (processor.getCapabilities) {
      console.log(`🧠 [DataFetcher] Usando capabilities del procesador base`);
      result.capabilities = processor.getCapabilities();
    }
    
    return result;
  }
  
  /**
   * Extrae capabilities desde un procesador
   */
  public static extractProcessorCapabilities(processor: Base): string[] {
    console.log(`🧠 [DataFetcher] Extrayendo capabilities del procesador ${processor.getId()}`);
    
    // Inicializar un conjunto para acumular todas las capabilities sin duplicados
    const allCapabilitiesSet = new Set<string>();
    
    // 1. Extraer capabilities directas del procesador si existen
    if ((processor as any).capabilities && Array.isArray((processor as any).capabilities)) {
      console.log(`🧠 [DataFetcher] Agregando capabilities directas del procesador`);
      (processor as any).capabilities.forEach((cap: string) => allCapabilitiesSet.add(cap));
      console.log(`🧠 [DataFetcher] Capabilities directas: ${Array.from((processor as any).capabilities).join(', ')}`);
    }
    
    // 2. Extraer capabilities desde las tools del procesador
    if ((processor as any).tools) {
      console.log(`🧠 [DataFetcher] Agregando capabilities de tools del procesador`);
      const toolCapabilities = CapabilitiesExtractor.extractCapabilitiesFromTools(
        (processor as any).tools, 
        `tools del procesador ${processor.getId()}`
      );
      toolCapabilities.forEach(cap => allCapabilitiesSet.add(cap));
    }
    
    return Array.from(allCapabilitiesSet);
  }
  
  /**
   * Extrae datos adicionales directamente desde el procesador
   */
  public static extractProcessorData(processor: Base): {
    name: string;
    description: string;
    backstory: string;
    systemPrompt: string;
    agentPrompt: string;
  } {
    const id = processor.getId();
    console.log(`🧠 [DataFetcher] Extrayendo datos adicionales del procesador ${id}`);
    
    const result = {
      name: processor.getName(),
      description: '',
      backstory: '',
      systemPrompt: '',
      agentPrompt: ''
    };
    
    // Extraer la información específica del procesador
    if ((processor as any).backstory) {
      console.log(`✅ [DataFetcher] Extrayendo backstory del procesador`);
      result.backstory = (processor as any).backstory;
    } else if ((processor as any).background) {
      console.log(`✅ [DataFetcher] Extrayendo background como backstory`);
      result.backstory = (processor as any).background;
    }
    
    if ((processor as any).systemPrompt) {
      console.log(`✅ [DataFetcher] Extrayendo systemPrompt del procesador`);
      result.systemPrompt = (processor as any).systemPrompt;
    } else if ((processor as any).customPrompt) {
      console.log(`✅ [DataFetcher] Extrayendo customPrompt como systemPrompt`);
      result.systemPrompt = (processor as any).customPrompt;
    }
    
    if ((processor as any).prompt) {
      console.log(`✅ [DataFetcher] Extrayendo prompt del procesador`);
      result.agentPrompt = (processor as any).prompt;
    }
    
    if ((processor as any).description) {
      console.log(`✅ [DataFetcher] Extrayendo descripción del procesador`);
      result.description = (processor as any).description;
    }
    
    return result;
  }
  
  /**
   * Obtiene capabilities de herramientas de un comando
   */
  public static async getCommandCapabilities(commandId?: string): Promise<string[]> {
    if (!commandId) {
      return [];
    }
    
    try {
      console.log(`🧠 [DataFetcher] Buscando capabilities para el comando: ${commandId}`);
      const command = await CommandCache.getCachedCommand(commandId);
      
      if (command && command.tools && Array.isArray(command.tools) && command.tools.length > 0) {
        console.log(`🧠 [DataFetcher] Procesando tools del comando ${commandId}`);
        return CapabilitiesExtractor.extractCapabilitiesFromTools(command.tools, `command ${commandId}`);
      }
    } catch (error) {
      console.error(`❌ [DataFetcher] Error al obtener tools del comando ${commandId}:`, error);
    }
    
    return [];
  }
} 