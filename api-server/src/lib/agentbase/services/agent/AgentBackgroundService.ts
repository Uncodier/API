/**
 * AgentBackgroundService - Servicio para la generación de backgrounds de agentes
 */
import { Base } from '../../agents/Base';
import { AgentCacheService } from './AgentCacheService';
import { FileProcessingService } from '../FileProcessingService';
import { BackgroundBuilder, CapabilitiesExtractor, DataFetcher } from './BackgroundServices';

export class AgentBackgroundService {
  private static instance: AgentBackgroundService;
  private agentCache: AgentCacheService;
  private fileProcessingService: FileProcessingService;
  
  private constructor() {
    this.agentCache = AgentCacheService.getInstance();
    this.fileProcessingService = FileProcessingService.getInstance();
    console.log('🧠 AgentBackgroundService: Inicializado');
  }
  
  public static getInstance(): AgentBackgroundService {
    if (!AgentBackgroundService.instance) {
      AgentBackgroundService.instance = new AgentBackgroundService();
    }
    return AgentBackgroundService.instance;
  }
  
  /**
   * Genera el background completo para un agente
   */
  public async generateAgentBackground(processor: Base, agentId?: string, commandId?: string): Promise<string> {
    console.log(`🧠 [AgentBackgroundService] INICIO generateAgentBackground para procesador: ${processor.getId()}, agentId: ${agentId || 'N/A'}, commandId: ${commandId || 'N/A'}`);
    console.log(`📋 [AgentBackgroundService] RESUMEN: Recolectando capabilities de procesador, command.tools y agent.tools`);
    
    try {
      // Si tenemos un agent_id UUID, intentar obtener información desde el caché o la base de datos
      if (agentId) {
        const agentData = await this.getBackgroundFromAgentId(processor, agentId, commandId);
        if (agentData) {
          return agentData;
        }
      }
      
      // Si no se pudo obtener información de la base de datos, usar la del procesador
      return await this.getBackgroundFromProcessor(processor, commandId);
    } catch (error) {
      console.error(`❌ [AgentBackgroundService] Error al generar agent background:`, error);
      
      // Fallback a un background mínimo en caso de error
      const id = processor.getId() || 'unknown';
      const name = processor.getName() || 'AI Assistant';
      const capabilities = processor.getCapabilities && processor.getCapabilities() || ['providing assistance'];
      
      return BackgroundBuilder.createEmergencyBackground(id, name, capabilities);
    }
  }
  
  /**
   * Intenta obtener un background desde agent_id
   */
  private async getBackgroundFromAgentId(processor: Base, agentId: string, commandId?: string): Promise<string | null> {
    try {
      // Obtener datos del agente desde caché/BD
      const agentData = await DataFetcher.getAgentData(agentId, processor);
      
      // Si encontramos datos, combinar con capabilities del comando
      if (agentData) {
        let capabilities = agentData.capabilities;
        
        // Añadir capabilities del comando si existen
        if (commandId) {
          const commandCapabilities = await DataFetcher.getCommandCapabilities(commandId);
          if (commandCapabilities.length > 0) {
            capabilities = CapabilitiesExtractor.combineCapabilities(capabilities, commandCapabilities);
            console.log(`🧠 [AgentBackgroundService] Capabilities combinadas con comando: ${capabilities.join(', ')}`);
          }
        }
        
        // Construir el background con toda la información
        let background = BackgroundBuilder.buildAgentPrompt(
          agentId,
          agentData.name,
          agentData.description,
          capabilities,
          agentData.backstory,
          agentData.systemPrompt,
          agentData.agentPrompt
        );
        
        // Añadir archivos al background si están disponibles
        if (agentData.files && agentData.files.length > 0) {
          console.log(`🧠 [AgentBackgroundService] Agregando ${agentData.files.length} archivos al background`);
          background = await this.fileProcessingService.appendAgentFilesToBackground(background, agentData.files);
        }
        
        console.log(`✅ [AgentBackgroundService] Background completo desde ID (${background.length} caracteres)`);
        return background;
      }
    } catch (error) {
      console.error(`❌ [AgentBackgroundService] Error al obtener background desde agentId:`, error);
    }
    
    return null;
  }
  
  /**
   * Genera un background desde el procesador
   */
  private async getBackgroundFromProcessor(processor: Base, commandId?: string): Promise<string> {
    console.log(`🔄 [AgentBackgroundService] Usando información del procesador local: ${processor.getId()}`);
    
    try {
      // Obtener la información básica del agente
      const id = processor.getId();
      const processorData = DataFetcher.extractProcessorData(processor);
      
      // Recopilar capabilities de todas las fuentes
      // 1. Del procesador
      const processorCapabilities = DataFetcher.extractProcessorCapabilities(processor);
      
      // 2. Del comando si está disponible
      let commandCapabilities: string[] = [];
      if (commandId) {
        commandCapabilities = await DataFetcher.getCommandCapabilities(commandId);
      }
      
      // Combinar todas las capabilities sin duplicados
      const capabilities = CapabilitiesExtractor.combineCapabilities(
        processorCapabilities,
        commandCapabilities
      );
      
      console.log(`🧠 [AgentBackgroundService] Total de capabilities únicas: ${capabilities.length}`);
      console.log(`🧠 [AgentBackgroundService] Lista completa de capabilities: ${capabilities.join(', ')}`);
      
      // Guardar las capabilities originales del procesador para comparación
      const processorOriginalCapabilities = processor.getCapabilities();
      console.log(`🧠 [AgentBackgroundService] Capabilities originales del procesador (${processorOriginalCapabilities.length}): ${processorOriginalCapabilities.join(', ')}`);
      
      // Comparación de capabilities
      const uniqueCapabilities = capabilities.filter(cap => !processorOriginalCapabilities.includes(cap));
      if (uniqueCapabilities.length > 0) {
        console.log(`🔍 [AgentBackgroundService] Capabilities adicionales encontradas (${uniqueCapabilities.length}): ${uniqueCapabilities.join(', ')}`);
      }
      
      // Obtener descripción (si no está en processorData)
      const agentDescription = processorData.description || 
                             `An AI assistant with capabilities in ${capabilities.join(', ')}`;
      
      // Construir el background final
      console.log(`🧩 [AgentBackgroundService] Construyendo agentPrompt final para ${id}`);
      const finalBackground = BackgroundBuilder.buildAgentPrompt(
        id, 
        processorData.name, 
        agentDescription, 
        capabilities,
        processorData.backstory,
        processorData.systemPrompt,
        processorData.agentPrompt
      );
      
      // Registrar para debugging
      console.log(`🧩 [AgentBackgroundService] Background final generado (${finalBackground.length} caracteres)`);
      console.log(`📋 [AgentBackgroundService] RESUMEN FINAL: Background generado con ${capabilities.length} capabilities.`);
      
      return finalBackground;
    } catch (procError) {
      console.error(`❌ [AgentBackgroundService] Error al generar background desde el procesador:`, procError);
      throw procError;
    }
  }
} 