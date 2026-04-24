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
  private static agentCache = new AgentCacheService(); // Fresh instance for Edge Functions
  
  /**
   * Valida específicamente la estructura de business_hours
   * @param businessHours Los datos de business_hours a validar
   * @returns true si contiene datos útiles, false si está vacío o mal estructurado
   */
  private static isBusinessHoursMeaningful(businessHours: any): boolean {
    if (!businessHours) return false;
    
    // Si es un string, verificar que no esté vacío
    if (typeof businessHours === 'string') {
      return businessHours.trim().length > 0;
    }
    
    // Si es un array, verificar que tenga elementos significativos
    if (Array.isArray(businessHours)) {
      return businessHours.length > 0 && businessHours.some(item => this.isValueMeaningful(item));
    }
    
    // Si es un objeto, verificar estructura específica para business_hours
    if (typeof businessHours === 'object' && businessHours !== null) {
      const keys = Object.keys(businessHours);
      if (keys.length === 0) return false;
      
      // Verificar que al menos una entrada tenga datos útiles
      return keys.some(day => {
        const hours = businessHours[day];
        // Verificar que el valor no sea null, undefined, string vacío o objeto vacío
        if (!hours) return false;
        if (typeof hours === 'string' && hours.trim() === '') return false;
        if (typeof hours === 'object' && hours !== null && Object.keys(hours).length === 0) return false;
        return true;
      });
    }
    
    return true; // Para otros tipos (number, boolean)
  }
  
  /**
   * Valida si un campo JSON/Array contiene datos útiles
   * @param value El valor a validar
   * @returns true si el valor contiene datos útiles, false si está vacío
   */
  private static isValueMeaningful(value: any): boolean {
    if (!value) return false;
    
    // Si es un string, verificar que no esté vacío después de trim
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }
    
    // Si es un array, verificar que tenga elementos
    if (Array.isArray(value)) {
      return value.length > 0 && value.some(item => this.isValueMeaningful(item));
    }
    
    // Si es un objeto, verificar que tenga propiedades significativas
    if (typeof value === 'object' && value !== null) {
      const keys = Object.keys(value);
      return keys.length > 0 && keys.some(key => this.isValueMeaningful(value[key]));
    }
    
    // Para otros tipos (number, boolean), considerar que son significativos
    return true;
  }
  
  /**
   * Procesa y limpia campos JSON para evitar incluir contenido vacío
   * @param data El objeto que contiene los campos a procesar
   * @param jsonFields Array con los nombres de los campos JSON a procesar
   * @param context Contexto para logging (ej: "site_settings")
   */
  private static processJsonFields(data: any, jsonFields: string[], context: string): void {
    jsonFields.forEach(field => {
      if (data && data[field] !== undefined) {
        // Verificar primero si el valor es null o string vacío
        if (data[field] === null || (typeof data[field] === 'string' && data[field].trim() === '')) {
          console.log(`🧹 [DataFetcher] Removiendo campo nulo/vacío ${field} de ${context} para ahorrar tokens`);
          delete data[field];
          return;
        }
        
        // Si es un string, intentar parsearlo
        if (typeof data[field] === 'string') {
          try {
            data[field] = JSON.parse(data[field]);
          } catch (e) {
            console.error(`[DataFetcher] Error parsing ${context} ${field}:`, e);
            delete data[field]; // Remover campos que no se pueden parsear
            return;
          }
        }
        
        // Validar si el valor es significativo
        if (field === 'business_hours') {
          // Usar validación específica para business_hours
          if (!this.isBusinessHoursMeaningful(data[field])) {
            console.log(`🧹 [DataFetcher] Removiendo business_hours vacío de ${context} para ahorrar tokens`);
            delete data[field];
          } else {
            console.log(`✅ [DataFetcher] Campo business_hours de ${context} contiene datos útiles`);
          }
        } else {
          // Usar validación general para otros campos
          if (!this.isValueMeaningful(data[field])) {
            console.log(`🧹 [DataFetcher] Removiendo campo vacío ${field} de ${context} para ahorrar tokens`);
            delete data[field];
          } else {
            console.log(`✅ [DataFetcher] Campo ${field} de ${context} contiene datos útiles`);
          }
        }
      }
    });
  }
  
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
    siteInfo?: {
      site: any | null;
      settings: any | null;
    };
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
      files: [],
      siteInfo: undefined
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
        
        // Obtener información del sitio y su configuración si está disponible
        if (agentData.site_id && DatabaseAdapter.isValidUUID(agentData.site_id)) {
          try {
            console.log(`🔍 [DataFetcher] El agente tiene site_id (${agentData.site_id}), obteniendo información del sitio`);
            const siteInfo = await this.getSiteInfo(agentData.site_id);
            if (siteInfo) {
              agentData.site = siteInfo.site;
              agentData.siteSettings = siteInfo.settings;
            }
          } catch (siteError) {
            console.error(`❌ [DataFetcher] Error al obtener información del sitio:`, siteError);
          }
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
   * Obtiene información completa de un sitio y sus configuraciones
   * @param siteId ID del sitio
   * @returns Objeto con la información del sitio y sus configuraciones
   */
  public static async getSiteInfo(siteId: string): Promise<{
    site: any | null;
    settings: any | null;
    copywriting?: any[] | null;
  }> {
    console.log(`🔍 [DataFetcher] Obteniendo información completa del sitio: ${siteId}`);
    
    const result = {
      site: null as any | null,
      settings: null as any | null,
      copywriting: null as any[] | null
    };
    
    // Si no es un UUID válido, retornar resultado vacío
    if (!siteId || !DatabaseAdapter.isValidUUID(siteId)) {
      console.log(`🧠 [DataFetcher] siteId no es válido: ${siteId}`);
      return result;
    }
    
    // Obtener información del sitio
    try {
      const siteData = await DatabaseAdapter.getSiteById(siteId);
      if (siteData) {
        console.log(`✅ [DataFetcher] Encontrada información del sitio: ${siteId}`);
        result.site = siteData;
        
        // Verificar si tiene campos JSON que necesitan ser convertidos
        const jsonFields = ['resource_urls', 'competitors', 'tracking', 'business_hours'];
        this.processJsonFields(result.site, jsonFields, 'site');
      }
    } catch (siteError) {
      console.error(`❌ [DataFetcher] Error al obtener información del sitio:`, siteError);
    }
    
    // Obtener configuración del sitio (de la tabla 'settings')
    try {
      const siteSettings = await DatabaseAdapter.getSiteSettingsById(siteId);
      if (siteSettings) {
        console.log(`✅ [DataFetcher] Encontrada configuración del sitio: ${siteId}`);
        result.settings = siteSettings;
        
        // Verificar si tiene campos JSON que necesitan ser convertidos
        const jsonFields = [
          'products', 'services', 'swot', 'locations', 'marketing_budget', 
          'marketing_channels', 'social_media', 'goals',
          'tracking', 'team_members', 'team_roles', 
          'org_structure', 'business_hours'
        ];
        
        this.processJsonFields(result.settings, jsonFields, 'site_settings');
      } else {
        console.log(`⚠️ [DataFetcher] No se encontró configuración para el sitio: ${siteId}`);
      }
    } catch (settingsError) {
      console.error(`❌ [DataFetcher] Error al obtener configuración del sitio:`, settingsError);
    }
    
    // Obtener copywriting del sitio (de la tabla 'copywriting')
    console.log(`🔍 [DataFetcher] Iniciando obtención de copywriting para sitio: ${siteId}`);
    try {
      const copywritingData = await DatabaseAdapter.getCopywritingBySiteId(siteId);
      console.log(`🔍 [DataFetcher] Copywriting obtenido:`, copywritingData);
      console.log(`🔍 [DataFetcher] Tipo de datos:`, typeof copywritingData);
      console.log(`🔍 [DataFetcher] Es array:`, Array.isArray(copywritingData));
      
      if (copywritingData && copywritingData.length > 0) {
        console.log(`✅ [DataFetcher] Encontrado copywriting del sitio: ${siteId} (${copywritingData.length} elementos)`);
        console.log(`✅ [DataFetcher] Estados en los datos:`, Array.from(new Set(copywritingData.map(item => item.status))));
        result.copywriting = copywritingData;
      } else {
        console.log(`⚠️ [DataFetcher] No se encontró copywriting para el sitio: ${siteId}`);
        console.log(`⚠️ [DataFetcher] Valor de copywritingData:`, copywritingData);
        result.copywriting = [];
      }
    } catch (copywritingError) {
      console.error(`❌ [DataFetcher] Error al obtener copywriting del sitio:`, copywritingError);
      result.copywriting = [];
    }
    
    return result;
  }
  
  /**
   * Extrae los datos relevantes de un objeto de agente
   */
  private static extractDataFromAgentObject(agentData: any, processor: Base): any {
    const config = agentData.configuration || {};
    
    // Preparar la información del sitio si está disponible
    let siteInfoObj = undefined;
    
    if (agentData.site || agentData.siteSettings) {
      siteInfoObj = {
        site: agentData.site || null,
        settings: agentData.siteSettings || null
      };
      
      console.log(`🧠 [DataFetcher] Información de sitio incluida para el agente ${agentData.id || 'desconocido'}`);
      console.log(`🧠 [DataFetcher] Site disponible: ${siteInfoObj.site ? 'SÍ' : 'NO'}`);
      console.log(`🧠 [DataFetcher] Settings disponible: ${siteInfoObj.settings ? 'SÍ' : 'NO'}`);
    } else {
      console.log(`🧠 [DataFetcher] No se encontró información de sitio para el agente ${agentData.id || 'desconocido'}`);
    }
    
    const result: {
      name: string;
      description: string;
      backstory: string;
      systemPrompt: string;
      agentPrompt: string;
      capabilities: string[];
      files: any[];
      siteInfo?: {
        site: any | null;
        settings: any | null;
      };
    } = {
      name: agentData.name || processor.getName(),
      description: '',
      backstory: '',
      systemPrompt: '',
      agentPrompt: '',
      capabilities: [] as string[],
      files: agentData.files || []
    };
    
    // Asignar siteInfo solo si existe información
    if (siteInfoObj) {
      result.siteInfo = siteInfoObj;
    }
    
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
  
  /**
   * Obtiene información combinada para un agente incluyendo información del sitio y configuración
   * @param agentId ID del agente
   * @param siteId ID del sitio (opcional, si no se proporciona, se intentará obtener del agente)
   * @param processor Procesador base
   * @returns Datos completos del agente con información del sitio
   */
  public static async getEnhancedAgentData(
    agentId: string, 
    siteId?: string, 
    processor?: Base
  ): Promise<{
    agentData: any;
    siteInfo: {
      site: any | null;
      settings: any | null;
    };
    formattedData: {
      name: string;
      description: string;
      backstory: string;
      systemPrompt: string;
      agentPrompt: string;
      capabilities: string[];
      files?: any[];
    };
  }> {
    // Si no se proporcionó un procesador, crear uno mínimo
    const defaultProcessor = processor || {
      getName: () => 'Agent',
      getId: () => 'default',
      getCapabilities: () => []
    } as unknown as Base;
    
    // Obtener datos del agente
    const agentData = await this.getAgentData(agentId, defaultProcessor);
    
    // Determinar qué ID de sitio usar
    let effectiveSiteId = siteId;
    
    // Si no se proporcionó un ID de sitio explícito, intentar obtenerlo del agente
    if (!effectiveSiteId) {
      // Intentar obtener desde la respuesta de getAgentData
      const siteIdFromAgent = (agentData as any).site_id;
      
      if (siteIdFromAgent && DatabaseAdapter.isValidUUID(siteIdFromAgent)) {
        console.log(`🧠 [DataFetcher] Usando site_id del agente: ${siteIdFromAgent}`);
        effectiveSiteId = siteIdFromAgent;
      }
    }
    
    // Obtener información del sitio si tenemos un ID válido
    let siteInfo = { site: null, settings: null };
    if (effectiveSiteId) {
      siteInfo = await this.getSiteInfo(effectiveSiteId);
    }
    
    // Crear copia del agentData para añadir la información del sitio
    const enhancedAgentData = {
      ...agentData
    };
    
    // Formatear los datos para devolverlos en el formato estándar
    const formattedData = this.extractDataFromAgentObject(enhancedAgentData, defaultProcessor);
    
    return {
      agentData: enhancedAgentData,
      siteInfo,
      formattedData
    };
  }
  
  /**
   * Obtiene las campañas activas para un sitio específico
   * @param siteId ID del sitio
   * @returns Array de campañas con título y descripción (solo si tienen valores)
   */
  public static async getActiveCampaigns(siteId: string): Promise<Array<{
    title: string;
    description?: string;
  }>> {
    try {
      if (!siteId || !DatabaseAdapter.isValidUUID(siteId)) {
        console.log(`❌ [DataFetcher] ID de sitio no válido para obtener campañas: ${siteId}`);
        return [];
      }

      console.log(`🔍 [DataFetcher] Obteniendo campañas activas para el sitio: ${siteId}`);
      
      // Importamos dinámicamente el supabaseAdmin para hacer la consulta
      const { supabaseAdmin } = await import('../../../../database/supabase-client');
      
      const { data: campaigns, error } = await supabaseAdmin
        .from('campaigns')
        .select('title, description')
        .eq('site_id', siteId)
        .eq('status', 'active')
        .order('created_at', { ascending: false });

      if (error) {
        console.error(`❌ [DataFetcher] Error al consultar campañas activas:`, error);
        return [];
      }

      if (!campaigns || campaigns.length === 0) {
        console.log(`⚠️ [DataFetcher] No se encontraron campañas activas para el sitio: ${siteId}`);
        return [];
      }

      // Filtrar campañas que tengan al menos un título válido
      const filteredCampaigns = campaigns
        .filter((campaign: any) => campaign.title && campaign.title.trim() !== '')
        .map((campaign: any) => ({
          title: campaign.title.trim(),
          ...(campaign.description && campaign.description.trim() !== '' 
            ? { description: campaign.description.trim() } 
            : {})
        }));

      console.log(`✅ [DataFetcher] Encontradas ${filteredCampaigns.length} campañas activas con título válido`);
      return filteredCampaigns;
    } catch (error) {
      console.error(`❌ [DataFetcher] Error al obtener campañas activas:`, error);
      return [];
    }
  }
}