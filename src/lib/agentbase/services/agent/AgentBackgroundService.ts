/**
 * AgentBackgroundService - Servicio para la generación de backgrounds de agentes
 */
import { Base } from '../../agents/Base';
import { AgentCacheService } from './AgentCacheService';
import { FileProcessingService } from '../FileProcessingService';
import { BackgroundBuilder, CapabilitiesExtractor, DataFetcher } from './BackgroundServices';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';

export class AgentBackgroundService {
  private agentCache: AgentCacheService;
  private fileProcessingService: FileProcessingService;
  
  constructor() {
    this.agentCache = new AgentCacheService(); // Fresh instance for Edge Functions
    this.fileProcessingService = new FileProcessingService(); // Fresh instance for Edge Functions
    console.log('🧠 [EDGE] AgentBackgroundService: Inicializado');
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
      console.log(`🔍 [AgentBackgroundService] Obteniendo información para agente: ${agentId}`);
      
      // Obtener datos del agente
      const agentData = await DataFetcher.getAgentData(agentId, processor);
      
      if (agentData) {
        // Obtener capabilities adicionales del comando si está disponible
        let capabilities = Array.isArray(agentData.capabilities) ? [...agentData.capabilities] : [];
        
        if (commandId) {
          const commandCapabilities = await DataFetcher.getCommandCapabilities(commandId);
          if (commandCapabilities.length > 0) {
            capabilities = CapabilitiesExtractor.combineCapabilities(capabilities, commandCapabilities);
            console.log(`🧠 [AgentBackgroundService] Capabilities combinadas: ${capabilities.join(', ')}`);
          }
        }
        
        // Siempre obtener siteInfo fresco para incluir copywriting actualizado
        let siteInfo = null;
        
        // Intentar obtener siteId de múltiples fuentes
        let siteId = null;
        if (processor.getId() && typeof processor.getId() === 'string' && processor.getId().startsWith('site_')) {
          siteId = processor.getId().replace('site_', '');
          console.log(`🔍 [AgentBackgroundService] Detectado agente de sitio, obteniendo información para sitio: ${siteId}`);
        } else if ((agentData as any).site_id) {
          siteId = (agentData as any).site_id;
          console.log(`🔍 [AgentBackgroundService] Obteniendo información para sitio: ${siteId}`);
        } else if (agentData.siteInfo?.site?.id) {
          siteId = agentData.siteInfo.site.id;
          console.log(`🔍 [AgentBackgroundService] Usando site_id desde siteInfo existente: ${siteId}`);
        }
        
        // Obtener siteInfo fresco si tenemos un siteId válido
        if (siteId && DatabaseAdapter.isValidUUID(siteId)) {
          console.log(`🔍 [AgentBackgroundService] Obteniendo siteInfo fresco con copywriting para sitio: ${siteId}`);
          siteInfo = await DataFetcher.getSiteInfo(siteId);
          if (siteInfo) {
            console.log(`🔍 [AgentBackgroundService] SiteInfo fresco obtenido - Site disponible: ${siteInfo.site ? 'SÍ' : 'NO'}`);
            console.log(`🔍 [AgentBackgroundService] SiteInfo fresco obtenido - Settings disponible: ${siteInfo.settings ? 'SÍ' : 'NO'}`);
            console.log(`🔍 [AgentBackgroundService] SiteInfo fresco obtenido - Copywriting disponible: ${(siteInfo as any).copywriting ? 'SÍ' : 'NO'}`);
            if ((siteInfo as any).copywriting) {
              console.log(`🔍 [AgentBackgroundService] SiteInfo fresco obtenido - Copywriting elementos: ${(siteInfo as any).copywriting.length}`);
            }
          }
        } else {
          // Fallback al siteInfo existente si no hay manera de obtener uno fresco
          siteInfo = agentData.siteInfo;
          if (siteInfo) {
            console.log(`🔍 [AgentBackgroundService] Usando siteInfo existente como fallback`);
            console.log(`🔍 [AgentBackgroundService] Site disponible: ${siteInfo.site ? 'SÍ' : 'NO'}`);
            console.log(`🔍 [AgentBackgroundService] Settings disponible: ${siteInfo.settings ? 'SÍ' : 'NO'}`);
            console.log(`🔍 [AgentBackgroundService] Copywriting disponible: ${(siteInfo as any).copywriting ? 'SÍ' : 'NO'}`);
          }
        }
        
        // Obtener campañas activas si hay información del sitio
        let activeCampaigns: Array<{ title: string; description?: string }> = [];
        if (siteInfo?.site?.id) {
          try {
            activeCampaigns = await DataFetcher.getActiveCampaigns(siteInfo.site.id);
          } catch (error) {
            console.error(`❌ [AgentBackgroundService] Error al obtener campañas activas:`, error);
          }
        }

        // Construir el background con toda la información
        // Nota: Pasamos la información del sitio directamente a BackgroundBuilder
        // quien se encargará de formatearla correctamente
        console.log(`🔍 [AgentBackgroundService] *** LLAMANDO A BackgroundBuilder.buildAgentPrompt ***`);
        console.log(`🔍 [AgentBackgroundService] SiteInfo antes de BackgroundBuilder:`, siteInfo);
        console.log(`🔍 [AgentBackgroundService] SiteInfo.copywriting:`, (siteInfo as any)?.copywriting);
        let background = BackgroundBuilder.buildAgentPrompt(
          agentId,
          agentData.name,
          agentData.description,
          capabilities,
          agentData.backstory,
          agentData.systemPrompt,
          agentData.agentPrompt,
          siteInfo,
          activeCampaigns
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
      
      // Obtener información del sitio si es necesario
      let siteInfo: { site: any | null; settings: any | null } | undefined = undefined;
      
      if (id && typeof id === 'string') {
        // Para agentes de tipo "site_*" intentar obtener información del sitio directamente
        if (id.startsWith('site_')) {
          const siteId = id.replace('site_', '');
          console.log(`🔍 [AgentBackgroundService] Detectado agente de sitio en procesador, obteniendo información para sitio: ${siteId}`);
          if (DatabaseAdapter.isValidUUID(siteId)) {
            siteInfo = await DataFetcher.getSiteInfo(siteId);
          }
        }
        // Si el procesador tiene site_id como propiedad
        else if ((processor as any).site_id && DatabaseAdapter.isValidUUID((processor as any).site_id)) {
          console.log(`🔍 [AgentBackgroundService] Procesador tiene site_id: ${(processor as any).site_id}`);
          siteInfo = await DataFetcher.getSiteInfo((processor as any).site_id);
        }
      }
      
      // Obtener campañas activas si hay información del sitio
      let activeCampaigns: Array<{ title: string; description?: string }> = [];
      if (siteInfo?.site?.id) {
        try {
          activeCampaigns = await DataFetcher.getActiveCampaigns(siteInfo.site.id);
        } catch (error) {
          console.error(`❌ [AgentBackgroundService] Error al obtener campañas activas:`, error);
        }
      }

      // Construir el background final
      console.log(`🧩 [AgentBackgroundService] Construyendo agentPrompt final para ${id}`);
      const finalBackground = BackgroundBuilder.buildAgentPrompt(
        id, 
        processorData.name, 
        agentDescription, 
        capabilities,
        processorData.backstory,
        processorData.systemPrompt,
        processorData.agentPrompt,
        siteInfo,
        activeCampaigns
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
  
  /**
   * Genera un background completo para un agente incluyendo información de un sitio específico
   * @param processor Procesador base
   * @param agentId ID del agente (opcional)
   * @param siteId ID del sitio (obligatorio)
   * @param commandId ID del comando (opcional)
   */
  public async generateEnhancedAgentBackground(processor: Base, agentId?: string, siteId?: string, commandId?: string): Promise<string> {
    console.log(`🧠 [AgentBackgroundService] Generando background con sitio específico: ${siteId || 'N/A'}`);
    
    try {
      if (!siteId || !DatabaseAdapter.isValidUUID(siteId)) {
        console.error(`❌ [AgentBackgroundService] ID de sitio no válido: ${siteId}`);
        // Si no hay siteId válido, usar el método estándar
        return this.generateAgentBackground(processor, agentId, commandId);
      }
      
      // Obtener información del sitio
      const siteInfo = await DataFetcher.getSiteInfo(siteId);
      if (!siteInfo.site && !siteInfo.settings) {
        console.warn(`⚠️ [AgentBackgroundService] No se encontró información para el sitio ${siteId}`);
        // Si no hay info del sitio, usar el método estándar
        return this.generateAgentBackground(processor, agentId, commandId);
      }
      
      // Si tenemos un agentId, obtener sus datos normales y enriquecerlos
      if (agentId) {
        try {
          // Obtener datos del agente
          const enhancedAgentData = await DataFetcher.getEnhancedAgentData(agentId, siteId, processor);
          
          if (enhancedAgentData && enhancedAgentData.formattedData) {
            // Añadir capabilities del comando si existen
            let capabilities = enhancedAgentData.formattedData.capabilities || [];
            
            if (commandId) {
              const commandCapabilities = await DataFetcher.getCommandCapabilities(commandId);
              if (commandCapabilities.length > 0) {
                capabilities = CapabilitiesExtractor.combineCapabilities(capabilities, commandCapabilities);
                console.log(`🧠 [AgentBackgroundService] Capabilities combinadas: ${capabilities.join(', ')}`);
              }
            }
            
            // Obtener campañas activas
            let activeCampaigns: Array<{ title: string; description?: string }> = [];
            try {
              activeCampaigns = await DataFetcher.getActiveCampaigns(siteId);
            } catch (error) {
              console.error(`❌ [AgentBackgroundService] Error al obtener campañas activas:`, error);
            }

            // Construir el background con toda la información
            let background = BackgroundBuilder.buildAgentPrompt(
              agentId,
              enhancedAgentData.formattedData.name,
              enhancedAgentData.formattedData.description,
              capabilities,
              enhancedAgentData.formattedData.backstory,
              enhancedAgentData.formattedData.systemPrompt,
              enhancedAgentData.formattedData.agentPrompt,
              enhancedAgentData.siteInfo,
              activeCampaigns
            );
            
            // Añadir archivos al background si están disponibles
            if (enhancedAgentData.formattedData.files && enhancedAgentData.formattedData.files.length > 0) {
              console.log(`🧠 [AgentBackgroundService] Agregando ${enhancedAgentData.formattedData.files.length} archivos al background`);
              background = await this.fileProcessingService.appendAgentFilesToBackground(
                background, 
                enhancedAgentData.formattedData.files
              );
            }
            
            console.log(`✅ [AgentBackgroundService] Background completo enriquecido con sitio: ${siteId} (${background.length} caracteres)`);
            return background;
          }
        } catch (error) {
          console.error(`❌ [AgentBackgroundService] Error obteniendo datos enriquecidos:`, error);
          // Continuar con la generación basada solo en processor + siteInfo
        }
      }
      
      // Si no hay agentId o falla la obtención, usar solo processor + siteInfo
      const processorData = DataFetcher.extractProcessorData(processor);
      const processorCapabilities = DataFetcher.extractProcessorCapabilities(processor);
      
      // Añadir capabilities del comando si existen
      let capabilities = [...processorCapabilities];
      if (commandId) {
        const commandCapabilities = await DataFetcher.getCommandCapabilities(commandId);
        if (commandCapabilities.length > 0) {
          capabilities = CapabilitiesExtractor.combineCapabilities(capabilities, commandCapabilities);
        }
      }
      
      // Obtener campañas activas
      let activeCampaigns: Array<{ title: string; description?: string }> = [];
      try {
        activeCampaigns = await DataFetcher.getActiveCampaigns(siteId);
      } catch (error) {
        console.error(`❌ [AgentBackgroundService] Error al obtener campañas activas:`, error);
      }

      // Construir el background con la información del processor y el sitio
      const background = BackgroundBuilder.buildAgentPrompt(
        processor.getId() || 'generic',
        processorData.name,
        processorData.description,
        capabilities,
        processorData.backstory,
        processorData.systemPrompt,
        processorData.agentPrompt,
        siteInfo,
        activeCampaigns
      );
      
      console.log(`✅ [AgentBackgroundService] Background generado desde processor con sitio: ${siteId} (${background.length} caracteres)`);
      return background;
      
    } catch (error) {
      console.error(`❌ [AgentBackgroundService] Error al generar background enriquecido:`, error);
      // Fallback al método estándar
      return this.generateAgentBackground(processor, agentId, commandId);
    }
  }
} 