/**
 * AgentBackgroundService - Servicio para la generación de backgrounds de agentes
 */
import { Base } from '../../agents/Base';
import { AgentCacheService } from './AgentCacheService';
import { FileProcessingService } from '../FileProcessingService';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';

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
  public async generateAgentBackground(processor: Base, agentId?: string): Promise<string> {
    console.log(`🧠 [AgentBackgroundService] INICIO generateAgentBackground para procesador: ${processor.getId()}, agentId: ${agentId || 'N/A'}`);
    
    // Información base del agente
    let agentName = processor.getName();
    let agentDescription = '';
    let capabilities: string[] = [];
    let backstory = '';
    let systemPrompt = '';
    let agentPrompt = '';
    
    // Si tenemos un agent_id UUID, intentar obtener información desde el caché o la base de datos
    if (agentId && DatabaseAdapter.isValidUUID(agentId)) {
      console.log(`🧠 [AgentBackgroundService] agentId es un UUID válido: ${agentId}`);
      
      // Intentar obtener del caché
      try {
        console.log(`🔍 [AgentBackgroundService] Buscando información en caché para el agente: ${agentId}`);
        const cacheResult = await this.agentCache.getAgentData(agentId);
        
        if (cacheResult) {
          console.log(`✅ [AgentBackgroundService] Encontrada información en caché para el agente: ${agentId}`);
          const { agentData } = cacheResult;
          
          // Extraer información relevante del caché
          const config = agentData.configuration || {};
          
          // Obtener nombre del agente
          if (agentData.name) {
            agentName = agentData.name;
          }
          
          // Obtener backstory si está disponible
          if (config.backstory) {
            console.log(`🧠 [AgentBackgroundService] Encontrado backstory en config para el agente ${agentId} (${config.backstory.length} caracteres)`);
            backstory = config.backstory;
          } else if (agentData.backstory) {
            console.log(`🧠 [AgentBackgroundService] Encontrado backstory en agentData para el agente ${agentId} (${agentData.backstory.length} caracteres)`);
            backstory = agentData.backstory;
          }
          
          // Obtener systemPrompt si está disponible
          if (config.systemPrompt) {
            console.log(`🧠 [AgentBackgroundService] Encontrado systemPrompt para el agente ${agentId} (${config.systemPrompt.length} caracteres)`);
            systemPrompt = config.systemPrompt;
          }
          
          // Obtener prompt específico si está disponible
          if (config.prompt) {
            console.log(`🧠 [AgentBackgroundService] Encontrado prompt para el agente ${agentId} (${config.prompt.length} caracteres)`);
            agentPrompt = config.prompt;
          }
          
          // Obtener descripción si está disponible
          if (config.description) {
            console.log(`🧠 [AgentBackgroundService] Encontrada descripción en config para el agente ${agentId}`);
            agentDescription = config.description;
          } else if (agentData.description) {
            console.log(`🧠 [AgentBackgroundService] Encontrada descripción en agentData para el agente ${agentId}`);
            agentDescription = agentData.description;
          }
          
          // Obtener capabilities de tools si están disponibles
          if (agentData.tools && Array.isArray(agentData.tools) && agentData.tools.length > 0) {
            console.log(`🧠 [AgentBackgroundService] Extrayendo capabilities de tools para el agente ${agentId}`);
            capabilities = agentData.tools.map((tool: any) => {
              if (typeof tool === 'string') return tool;
              return tool.name || tool.description || tool.id || 'herramienta sin nombre';
            });
            console.log(`🧠 [AgentBackgroundService] Capabilities extraídas de tools: ${capabilities.join(', ')}`);
          } else if (config.capabilities) {
            console.log(`🧠 [AgentBackgroundService] Usando capabilities de config para el agente ${agentId}`);
            capabilities = config.capabilities;
          } else if (processor.getCapabilities) {
            console.log(`🧠 [AgentBackgroundService] Usando capabilities del procesador base para el agente ${agentId}`);
            capabilities = processor.getCapabilities();
          }
          
          // Recuperar archivos del agente si están disponibles
          let agentFiles = [];
          if (agentData.files && Array.isArray(agentData.files)) {
            console.log(`🧠 [AgentBackgroundService] Encontrados ${agentData.files.length} archivos para el agente ${agentId}`);
            agentFiles = agentData.files;
          }
          
          // Construir el background completo con toda la información disponible
          let agentBackground = this.buildAgentPrompt(
            agentId,
            agentName,
            agentDescription,
            capabilities,
            backstory,
            systemPrompt,
            agentPrompt
          );
          
          // Añadir archivos al background si están disponibles
          if (agentFiles.length > 0) {
            console.log(`🧠 [AgentBackgroundService] Agregando ${agentFiles.length} archivos al background`);
            agentBackground = await this.fileProcessingService.appendAgentFilesToBackground(agentBackground, agentFiles);
          }
          
          console.log(`✅ [AgentBackgroundService] Background completo construido desde caché (${agentBackground.length} caracteres)`);
          return agentBackground;
        } else {
          console.log(`🔍 [AgentBackgroundService] No se encontró información en caché para el agente: ${agentId}`);
        }
      } catch (cacheError) {
        console.error(`❌ [AgentBackgroundService] Error al buscar en caché:`, cacheError);
      }
      
      // Si no se encontró en caché, buscar en la base de datos
      try {
        console.log(`🔍 [AgentBackgroundService] Buscando información del agente en la base de datos: ${agentId}`);
        const agentData = await DatabaseAdapter.getAgentById(agentId);
        
        if (agentData) {
          console.log(`✅ [AgentBackgroundService] Encontrada información en la base de datos para el agente: ${agentId}`);
          
          // Obtener los archivos del agente desde la base de datos
          console.log(`🔍 [AgentBackgroundService] Buscando archivos del agente en la base de datos: ${agentId}`);
          const agentFiles = await DatabaseAdapter.getAgentFiles(agentId);
          
          // Añadir los archivos a los datos del agente
          if (agentFiles && agentFiles.length > 0) {
            console.log(`✅ [AgentBackgroundService] Encontrados ${agentFiles.length} archivos para el agente: ${agentId}`);
            agentData.files = agentFiles;
          } else {
            console.log(`ℹ️ [AgentBackgroundService] No se encontraron archivos para el agente: ${agentId}`);
          }
          
          // Guardar en caché para futuras consultas
          this.agentCache.setAgentData(agentId, agentData);
          console.log(`✅ [AgentBackgroundService] Información del agente guardada en caché: ${agentId}`);
          
          // Extraer información relevante de la base de datos
          const config = agentData.configuration || {};
          
          // Obtener nombre del agente
          if (agentData.name) {
            agentName = agentData.name;
          }
          
          // Obtener backstory si está disponible
          if (config.backstory) {
            console.log(`🧠 [AgentBackgroundService] Encontrado backstory en config para el agente ${agentId} (${config.backstory.length} caracteres)`);
            backstory = config.backstory;
          } else if (agentData.backstory) {
            console.log(`🧠 [AgentBackgroundService] Encontrado backstory en agentData para el agente ${agentId} (${agentData.backstory.length} caracteres)`);
            backstory = agentData.backstory;
          }
          
          // Obtener systemPrompt si está disponible
          if (config.systemPrompt) {
            console.log(`🧠 [AgentBackgroundService] Encontrado systemPrompt para el agente ${agentId} (${config.systemPrompt.length} caracteres)`);
            systemPrompt = config.systemPrompt;
          }
          
          // Obtener prompt específico si está disponible
          if (config.prompt) {
            console.log(`🧠 [AgentBackgroundService] Encontrado prompt para el agente ${agentId} (${config.prompt.length} caracteres)`);
            agentPrompt = config.prompt;
          } else if (agentData.prompt) {
            console.log(`🧠 [AgentBackgroundService] Encontrado prompt en agentData para el agente ${agentId} (${agentData.prompt.length} caracteres)`);
            agentPrompt = agentData.prompt;
          }
          
          // Obtener descripción si está disponible
          if (config.description) {
            console.log(`🧠 [AgentBackgroundService] Encontrada descripción en config para el agente ${agentId}`);
            agentDescription = config.description;
          } else if (agentData.description) {
            console.log(`🧠 [AgentBackgroundService] Encontrada descripción en agentData para el agente ${agentId}`);
            agentDescription = agentData.description;
          }
          
          // Obtener capabilities de tools si están disponibles
          if (agentData.tools && Array.isArray(agentData.tools) && agentData.tools.length > 0) {
            console.log(`🧠 [AgentBackgroundService] Extrayendo capabilities de tools para el agente ${agentId}`);
            capabilities = agentData.tools.map((tool: any) => {
              if (typeof tool === 'string') return tool;
              return tool.name || tool.description || tool.id || 'herramienta sin nombre';
            });
            console.log(`🧠 [AgentBackgroundService] Capabilities extraídas de tools: ${capabilities.join(', ')}`);
          } else if (config.capabilities) {
            console.log(`🧠 [AgentBackgroundService] Usando capabilities de config para el agente ${agentId}`);
            capabilities = config.capabilities;
          } else if (processor.getCapabilities) {
            console.log(`🧠 [AgentBackgroundService] Usando capabilities del procesador base para el agente ${agentId}`);
            capabilities = processor.getCapabilities();
          }
          
          // Construir el background completo con toda la información disponible
          let agentBackground = this.buildAgentPrompt(
            agentId,
            agentName,
            agentDescription,
            capabilities,
            backstory,
            systemPrompt,
            agentPrompt
          );
          
          // Añadir los archivos del agente al background si existen
          if (agentFiles && agentFiles.length > 0) {
            console.log(`🧠 [AgentBackgroundService] Agregando ${agentFiles.length} archivos al background`);
            agentBackground = await this.fileProcessingService.appendAgentFilesToBackground(agentBackground, agentFiles);
          }

          console.log(`✅ [AgentBackgroundService] Background completo construido desde BD (${agentBackground.length} caracteres)`);
          return agentBackground;
        } else {
          console.log(`🔍 [AgentBackgroundService] No se encontró información en la base de datos para el agente: ${agentId}`);
        }
      } catch (dbError) {
        console.error(`❌ [AgentBackgroundService] Error al obtener información del agente desde la base de datos:`, dbError);
        // Fallback a usar información del procesador si hay error
      }
    } else if (agentId) {
      console.log(`🧠 [AgentBackgroundService] agentId no es un UUID válido: ${agentId}, usando información del procesador`);
    }
    
    // Si no se pudo obtener información de la base de datos, usar la del procesador
    console.log(`🔄 [AgentBackgroundService] Usando información del procesador local para agent_background: ${processor.getId()}`);
    
    try {
      // Obtener la información básica del agente directamente de la instancia
      const id = processor.getId();
      agentName = processor.getName();
      
      // Extraer capabilities desde las tools del procesador si están disponibles
      if ((processor as any).tools && Array.isArray((processor as any).tools) && (processor as any).tools.length > 0) {
        console.log(`🧠 [AgentBackgroundService] Extrayendo capabilities de tools para el procesador ${id}`);
        capabilities = (processor as any).tools.map((tool: any) => {
          if (typeof tool === 'string') return tool;
          return tool.name || tool.description || tool.id || 'herramienta sin nombre';
        });
        console.log(`🧠 [AgentBackgroundService] Capabilities extraídas de tools: ${capabilities.join(', ')}`);
      } else if (processor.getCapabilities) {
        console.log(`🧠 [AgentBackgroundService] Usando capabilities del procesador base para el procesador ${id}`);
        capabilities = processor.getCapabilities();
      } else {
        console.log(`🧠 [AgentBackgroundService] Sin tools ni getCapabilities, usando capabilities por defecto`);
        capabilities = ['providing assistance'];
      }
      
      // Obtener todas las propiedades disponibles del agente
      const processorProps = Object.getOwnPropertyNames(processor)
        .filter(prop => typeof (processor as any)[prop] !== 'function' && prop !== 'id' && prop !== 'name');
      
      console.log(`🔍 [AgentBackgroundService] Propiedades del agente ${id}: ${processorProps.join(', ')}`);
      
      // Extraer la información específica del procesador
      if ((processor as any).backstory) {
        console.log(`✅ [AgentBackgroundService] Extrayendo backstory personalizado del agente ${id}`);
        backstory = (processor as any).backstory;
      }
      
      if ((processor as any).systemPrompt) {
        console.log(`✅ [AgentBackgroundService] Extrayendo systemPrompt personalizado del agente ${id}`);
        systemPrompt = (processor as any).systemPrompt;
      }
      
      if ((processor as any).customPrompt) {
        console.log(`✅ [AgentBackgroundService] Extrayendo customPrompt personalizado del agente ${id}`);
        systemPrompt = (processor as any).customPrompt;
      }
      
      if ((processor as any).prompt) {
        console.log(`✅ [AgentBackgroundService] Extrayendo prompt personalizado del agente ${id}`);
        agentPrompt = (processor as any).prompt;
      }
      
      if ((processor as any).background) {
        console.log(`✅ [AgentBackgroundService] Extrayendo background personalizado del agente ${id}`);
        backstory = (processor as any).background;
      }
      
      // Obtener la descripción del agente
      agentDescription = (processor as any).description || 
                         `An AI assistant with capabilities in ${capabilities.join(', ')}`;
      
      // Construir el background final
      console.log(`🧩 [AgentBackgroundService] Construyendo agentPrompt final con procesador ${id}`);
      const finalBackground = this.buildAgentPrompt(
        id, 
        agentName, 
        agentDescription, 
        capabilities, 
        backstory,
        systemPrompt,
        agentPrompt
      );
      
      // Registrar para debugging
      console.log(`🧩 [AgentBackgroundService] Agent background final generado para ${agentName} con longitud: ${finalBackground.length} caracteres`);
      console.log(`🔍 [AgentBackgroundService] Contiene instrucciones personalizadas: ${finalBackground.includes('# Agent Custom Instructions')}`);
      console.log(`🔍 [AgentBackgroundService] Primera parte del background: ${finalBackground.substring(0, 100)}...`);
      
      return finalBackground;
    } catch (procError) {
      console.error(`❌ [AgentBackgroundService] Error al generar background desde el procesador:`, procError);
      
      // Fallback a un background mínimo en caso de error
      const id = processor.getId() || 'unknown';
      const name = processor.getName() || 'AI Assistant';
      const capabilities = processor.getCapabilities && processor.getCapabilities() || ['providing assistance'];
      
      console.log(`⚠️ [AgentBackgroundService] Generando background mínimo de emergencia para: ${id}`);
      
      const emergencyBackground = `# Agent Identity
You are ${name} (ID: ${id}).

# Capabilities
Your capabilities include: ${Array.isArray(capabilities) ? capabilities.join(', ') : 'providing assistance'}.

# Instructions
1. Respond helpfully to user requests.
2. Use your capabilities effectively.
3. Be concise and clear in your responses.
4. Your name is "${name}" - whenever asked about your name, identity or what you are, respond with this name.`;
      
      console.log(`⚠️ [AgentBackgroundService] Background de emergencia generado (${emergencyBackground.length} caracteres)`);
      return emergencyBackground;
    }
  }
  
  /**
   * Método para construir el prompt del agente de manera consistente
   * Incorpora todas las fuentes de información disponibles
   */
  private buildAgentPrompt(
    id: string,
    name: string,
    description: string,
    capabilities: string[],
    backstory?: string,
    systemPrompt?: string,
    agentPrompt?: string
  ): string {
    console.log(`🧩 Construyendo prompt para ${name} (${id})`);
    console.log(`🧩 AgentPrompt disponible: ${agentPrompt ? 'SÍ' : 'NO'} - Longitud: ${agentPrompt ? agentPrompt.length : 0}`);
    console.log(`🧩 SystemPrompt disponible: ${systemPrompt ? 'SÍ' : 'NO'} - Longitud: ${systemPrompt ? systemPrompt.length : 0}`);
    console.log(`🧩 Backstory disponible: ${backstory ? 'SÍ' : 'NO'} - Longitud: ${backstory ? backstory.length : 0}`);
    
    // Construir el prompt de forma estructurada, asegurándonos de incluir todos los elementos
    let finalPrompt = '';

    // 1. Bloque de identidad - Siempre incluir nombre e ID
    finalPrompt += `# Agent Identity\nYou are ${name} (ID: ${id}).\n\n`;
    
    // 2. Bloque de backstory - Moverlo al inicio, justo después de la identidad
    if (backstory && backstory.trim()) {
      console.log(`🔍 Añadiendo backstory del agente al inicio: ${backstory.substring(0, 50)}...`);
      finalPrompt += `# Backstory\n${backstory}\n\n`;
    }
    
    // 3. Bloque de descripción - Si está disponible
    if (description && description.trim()) {
      finalPrompt += `# Description\n${description}\n\n`;
    }
    
    // 4. Bloque de capacidades - Listarlas formalmente
    const capabilitiesStr = Array.isArray(capabilities) && capabilities.length > 0
      ? capabilities.join(', ') 
      : 'providing assistance';
    
    finalPrompt += `# Capabilities\nYour capabilities include: ${capabilitiesStr}.\n\n`;
    
    // 5. Bloque de instrucciones - Siempre incluir instrucciones básicas
    finalPrompt += `# Instructions\n`;
    finalPrompt += `1. Respond helpfully to user requests.\n`;
    finalPrompt += `2. Use your capabilities effectively.\n`;
    finalPrompt += `3. Be concise and clear in your responses.\n`;
    finalPrompt += `4. Your name is "${name}" - whenever asked about your name, identity or what you are, respond with this name.\n\n`;
    
    // 6. Bloque de SystemPrompt - Si está disponible
    if (systemPrompt && systemPrompt.trim()) {
      console.log(`🔍 Añadiendo systemPrompt del agente: ${systemPrompt.substring(0, 50)}...`);
      finalPrompt += `# System Instructions\n${systemPrompt}\n\n`;
    }
    
    // 7. Bloque de Agent Custom Instructions - Si está disponible
    if (agentPrompt && agentPrompt.trim()) {
      console.log(`🔍 Añadiendo prompt específico del agente (agent.prompt): ${agentPrompt.substring(0, 50)}...`);
      finalPrompt += `# Agent Custom Instructions\n${agentPrompt}\n\n`;
    }
    
    console.log(`📏 Longitud total del prompt generado: ${finalPrompt.length} caracteres`);
    console.log(`📋 Estructura del prompt generado:\n${finalPrompt.split('\n').slice(0, 5).join('\n')}...\n(truncado para logs)`);
    
    // Verificar si el prompt contiene las secciones esperadas
    if (systemPrompt && !finalPrompt.includes('# System Instructions')) {
      console.error(`⚠️ ADVERTENCIA: Se esperaba incluir systemPrompt pero no se encontró en el prompt final`);
    }
    
    if (agentPrompt && !finalPrompt.includes('# Agent Custom Instructions')) {
      console.error(`⚠️ ADVERTENCIA: Se esperaba incluir las instrucciones personalizadas pero no se encontraron en el prompt final`);
    }
    
    if (backstory && !finalPrompt.includes('# Backstory')) {
      console.error(`⚠️ ADVERTENCIA: Se esperaba incluir backstory pero no se encontró en el prompt final`);
    }
    
    return finalPrompt;
  }
} 