/**
 * AgentBackgroundGenerator - Servicio para generar backgrounds completos para agentes
 */
import { Base } from '../../agents/Base';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';
import AgentBackgroundBuilder from './AgentBackgroundBuilder';

export class AgentBackgroundGenerator {
  // Caché de agentes recuperados de la base de datos con tiempo de expiración
  private agentCache: Record<string, {data: any, timestamp: number}> = {};
  // Tiempo de vida del caché en milisegundos (10 minutos)
  private readonly CACHE_TTL = 10 * 60 * 1000;

  // Generar el background completo para un agente
  public async generateAgentBackground(processor: Base, agentId?: string): Promise<string> {
    // Obtener información básica del agente para usar en todas las construcciones del prompt
    const id = processor.getId();
    const name = processor.getName();
    const capabilities = processor.getCapabilities();
    let backstory = "";
    let description = "";
    let agentPrompt = ""; // Instrucciones personalizadas definidas en agent.prompt
    
    // Si tenemos un agent_id UUID, intentar obtener información desde el caché o la base de datos
    if (agentId && DatabaseAdapter.isValidUUID(agentId)) {
      // Verificar primero en el caché y que no haya expirado
      const cacheEntry = this.agentCache[agentId];
      const now = Date.now();
      
      if (cacheEntry && (now - cacheEntry.timestamp) < this.CACHE_TTL) {
        console.log(`✅ Usando información del agente desde caché: ${agentId}`);
        const agentData = cacheEntry.data;
        
        // Lógica para extraer información de backstory y description del caché
        const config = agentData.configuration || {};
        
        // Obtener backstory si está disponible
        if (config.backstory) {
          console.log(`🧠 Usando backstory de caché para el agente ${agentId}`);
          backstory = config.backstory;
        } else if (agentData.backstory) {
          console.log(`🧠 Usando backstory de caché para el agente ${agentId}`);
          backstory = agentData.backstory;
        }
        
        // Obtener prompt específico del agente si está disponible (agent.prompt)
        if (config.prompt) {
          console.log(`🧠 Usando prompt específico de caché para el agente ${agentId}`);
          agentPrompt = config.prompt;
        } else if (agentData.prompt) {
          console.log(`🧠 Usando prompt de caché para el agente ${agentId}`);
          agentPrompt = agentData.prompt;
        }
        
        // Obtener systemPrompt como backstory si no hay backstory específico
        if (!backstory && config.systemPrompt) {
          console.log(`🧠 Usando systemPrompt de caché como backstory para el agente ${agentId}`);
          backstory = config.systemPrompt;
        }
        
        // Obtener prompt como backstory si no hay backstory ni systemPrompt ni agentPrompt
        if (!backstory && !agentPrompt && config.prompt) {
          console.log(`🧠 Usando prompt de caché como backstory para el agente ${agentId}`);
          backstory = config.prompt;
        }
        
        // Obtener descripción
        description = config.description || agentData.description || '';
        
        // Si tenemos archivos, agréguelos al final
        const files = cacheEntry.data.files && Array.isArray(cacheEntry.data.files) 
          ? cacheEntry.data.files 
          : [];
          
        // Construir el prompt completo con la información recopilada
        let agentBackground = AgentBackgroundBuilder.buildAgentPrompt(
          agentId || id,
          agentData.name || name,
          description,
          config.capabilities || capabilities,
          backstory,
          agentPrompt // Pasamos las instrucciones personalizadas del agente (agent.prompt)
        );
        
        // Registrar lo que se está generando para debugging
        console.log(`🧩 Agent background generado para ${agentData.name || name} con longitud: ${agentBackground.length} caracteres`);
        console.log(`🔍 Contiene instrucciones personalizadas: ${agentBackground.includes('# Agent Custom Instructions')}`);
        
        // Añadir archivos al background si están disponibles
        if (files.length > 0) {
          agentBackground = await AgentBackgroundBuilder.appendAgentFilesToBackground(agentBackground, files);
        }
        
        return agentBackground;
      } else if (cacheEntry) {
        console.log(`⏰ Caché expirado para agente ${agentId}, consultando base de datos`);
        // Eliminar entrada expirada
        delete this.agentCache[agentId];
      }
      
      // Si no está en caché o expiró, buscar en la base de datos
      try {
        console.log(`🔍 Buscando información del agente en la base de datos: ${agentId}`);
        const agentData = await DatabaseAdapter.getAgentById(agentId);
        
        if (agentData) {
          // Obtener los archivos del agente desde la base de datos
          console.log(`🔍 Buscando archivos del agente en la base de datos: ${agentId}`);
          const agentFiles = await DatabaseAdapter.getAgentFiles(agentId);
          
          // Añadir los archivos a los datos del agente
          const files = agentFiles && agentFiles.length > 0 ? agentFiles : [];
          if (files.length > 0) {
            agentData.files = files;
          }
          
          // Guardar en caché para futuras consultas
          this.agentCache[agentId] = { data: agentData, timestamp: Date.now() };
          console.log(`✅ Información del agente encontrada en la base de datos y guardada en caché: ${agentId}`);
          
          // Obtener información para el prompt
          const config = agentData.configuration || {};
          
          // Obtener backstory si está disponible
          if (config.backstory) {
            console.log(`🧠 Usando backstory de la base de datos para el agente ${agentId}`);
            backstory = config.backstory;
          } else if (agentData.backstory) {
            console.log(`🧠 Usando backstory de la base de datos para el agente ${agentId}`);
            backstory = agentData.backstory;
          }
          
          // Obtener prompt específico del agente si está disponible (agent.prompt)
          if (config.prompt) {
            console.log(`🧠 Usando prompt específico de la base de datos para el agente ${agentId}`);
            agentPrompt = config.prompt;
          } else if (agentData.prompt) {
            console.log(`🧠 Usando prompt de la base de datos para el agente ${agentId}`);
            agentPrompt = agentData.prompt;
          }
          
          // Obtener systemPrompt como backstory si no hay backstory específico
          if (!backstory && config.systemPrompt) {
            console.log(`🧠 Usando systemPrompt de la base de datos como backstory para el agente ${agentId}`);
            backstory = config.systemPrompt;
          }
          
          // Obtener prompt como backstory si no hay backstory ni systemPrompt y aún no tenemos prompt
          if (!backstory && !agentPrompt && config.prompt) {
            console.log(`🧠 Usando prompt de la base de datos como backstory para el agente ${agentId}`);
            backstory = config.prompt;
          }
          
          // Obtener descripción
          description = config.description || agentData.description || '';
          
          // Construir el prompt completo con la información recopilada
          let agentBackground = AgentBackgroundBuilder.buildAgentPrompt(
            agentId,
            agentData.name || name,
            description,
            config.capabilities || capabilities,
            backstory,
            agentPrompt // Pasamos las instrucciones personalizadas del agente (agent.prompt)
          );
          
          // Registrar lo que se está generando para debugging
          console.log(`🧩 Agent background generado para ${agentData.name} con longitud: ${agentBackground.length} caracteres`);
          console.log(`🔍 Contiene instrucciones personalizadas: ${agentBackground.includes('# Agent Custom Instructions')}`);
          console.log(`🔍 Primera parte del background: ${agentBackground.substring(0, 100)}...`);
          
          // Añadir archivos al background si están disponibles
          if (files.length > 0) {
            agentBackground = await AgentBackgroundBuilder.appendAgentFilesToBackground(agentBackground, files);
          }
          
          return agentBackground;
        }
      } catch (error) {
        console.error(`❌ Error al obtener información del agente desde la base de datos:`, error);
        // Fallback a usar información del procesador si hay error
      }
    }
    
    // Si no se pudo obtener información de la base de datos, usar la del procesador
    console.log(`🔄 Usando información del procesador local para agent_background`);
    
    // Obtener todas las propiedades disponibles del agente
    const processorProps = Object.getOwnPropertyNames(processor)
      .filter(prop => typeof (processor as any)[prop] !== 'function' && prop !== 'id' && prop !== 'name');
    
    console.log(`🔍 Propiedades del agente ${id}: ${processorProps.join(', ')}`);
    
    // Si el agente tiene una propiedad backstory, customPrompt o systemPrompt, usarla para el backstory
    if ((processor as any).backstory) {
      console.log(`✅ Usando backstory personalizado del agente ${id}`);
      backstory = (processor as any).backstory;
    } else if ((processor as any).systemPrompt) {
      console.log(`✅ Usando systemPrompt personalizado del agente ${id}`);
      backstory = (processor as any).systemPrompt;
    } else if ((processor as any).customPrompt) {
      console.log(`✅ Usando customPrompt personalizado del agente ${id}`);
      backstory = (processor as any).customPrompt;
    } else if ((processor as any).prompt) {
      console.log(`✅ Usando prompt personalizado del agente ${id} (agent.prompt)`);
      agentPrompt = (processor as any).prompt;
    } else if ((processor as any).background) {
      console.log(`✅ Usando background personalizado del agente ${id}`);
      backstory = (processor as any).background;
    }
    
    // Obtener la descripción del agente
    description = (processor as any).description || 
                 `An AI assistant with capabilities in ${capabilities.join(', ')}`;
    
    // SIEMPRE usar buildAgentPrompt para construir el background final
    const finalBackground = AgentBackgroundBuilder.buildAgentPrompt(id, name, description, capabilities, backstory, agentPrompt);
    
    // Registrar para debugging
    console.log(`🧩 Agent background final generado para ${name} con longitud: ${finalBackground.length} caracteres`);
    console.log(`🔍 Contiene instrucciones personalizadas: ${finalBackground.includes('# Agent Custom Instructions')}`);
    console.log(`🔍 Primera parte del background: ${finalBackground.substring(0, 100)}...`);
    
    return finalBackground;
  }
}

export default new AgentBackgroundGenerator(); 