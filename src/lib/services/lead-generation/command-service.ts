/**
 * Funciones para manejo de comandos y agentes
 */

import { CommandFactory, ProcessorInitializer } from '@/lib/agentbase';

// Inicializar el agente y obtener el servicio de comandos
const processorInitializer = ProcessorInitializer.getInstance();
processorInitializer.initialize();
const commandService = processorInitializer.getCommandService();

// Función waitForCommandCompletion movida al endpoint route.ts para mejor manejo de errores

/**
 * Función para crear y enviar un comando de lead generation
 */
export async function createLeadGenerationCommand(
  userId: string,
  agentId: string | null,
  siteId: string,
  maxLeads: number,
  searchTopic: string,
  contextMessage: string,
  usedCities: string[],
  usedRegions: { [key: string]: string[] },
  tools: any[],
  webhook?: { url: string; secret?: string; metadata?: any }
): Promise<string> {
  
  const targetConfig = {
    target_city: null,
    target_region: null,
    search_topic: searchTopic,
    leads_count: maxLeads,
    segment_analysis: {
      total_segments: 0,
      converted_leads_analyzed: 0,
      non_converted_leads_analyzed: 0
    },
    location_guidance: {
      instruction: "Determine target location from business background/context. If no specific location mentioned, use best judgment for business type.",
      previously_searched_cities: usedCities,
      previously_searched_regions: usedRegions
    }
  };
  
  const command = CommandFactory.createCommand({
    task: "generate qualified sales leads",
    userId: userId,
    agentId: agentId,
    site_id: siteId,
    description: `Generate ${maxLeads} qualified leads focusing on ${searchTopic}. Determine location from business background.`,
    targets: [targetConfig],
    tools,
    context: contextMessage,
    supervisor: [
      {
        agent_role: "lead_quality_analyst",
        status: "not_initialized"
      },
      {
        agent_role: "local_market_researcher",
        status: "not_initialized"
      }
    ],
    model: "gpt-4.1",
    modelType: "openai",
    metadata: webhook ? { 
      webhook_url: webhook.url,
      webhook_secret: webhook.secret,
      webhook_metadata: webhook.metadata,
      search_topic: searchTopic,
      previously_searched_cities: usedCities,
      previously_searched_regions: usedRegions
    } : {
      search_topic: searchTopic,
      previously_searched_cities: usedCities,
      previously_searched_regions: usedRegions
    }
  } as any);
  
  // Enviar comando para procesamiento
  const internalCommandId = await commandService.submitCommand(command);
  console.log(`📝 Comando de lead generation creado con internal ID: ${internalCommandId}`);
  
  return internalCommandId;
}

/**
 * Función para extraer valores determinados por el agente de los resultados del comando
 */
export function extractCommandResults(executedCommand: any, searchTopic: string): {
  determinedCity: string | null,
  determinedRegion: string | null,
  determinedTopic: string
} {
  const results = executedCommand.results || [];
  const targetResult = results.find((r: any) => r.target_city !== undefined || r.target_region !== undefined) || results[0];
  
  const determinedCity = targetResult?.target_city || null;
  const determinedRegion = targetResult?.target_region || null;
  const determinedTopic = targetResult?.search_topic || searchTopic;
  
  console.log(`🎯 Valores determinados por el agente: city=${determinedCity}, region=${determinedRegion}, topic=${determinedTopic}`);
  
  return {
    determinedCity,
    determinedRegion,
    determinedTopic
  };
}

/**
 * Función para crear y enviar un comando de investigación de tipos de negocios
 */
export async function createBusinessTypeResearchCommand(
  userId: string,
  agentId: string | null,
  siteId: string,
  region: string,
  businessType: string,
  keywords: string[],
  maxBusinessTypes: number,
  businessResearchTopic: string,
  contextMessage: string,
  tools: any[],
  webhook?: { url: string; secret?: string; metadata?: any }
): Promise<string> {
  
  const targetConfig = {
    target_city: null,
    target_region: region === "to be determined by agent" ? null : region,
    business_type: businessType,
    keywords: keywords,
    business_research_topic: businessResearchTopic,
    business_types_count: maxBusinessTypes,
    business_types: [], // MANDATORY: This array must be populated with business type objects
    research_focus: {
      objective: "identify_business_types",
      scope: "regional_market_analysis", 
      priority: "lead_generation_potential"
    },
    location_guidance: {
      instruction: "CRITICAL: ALWAYS prioritize business locations defined in the background/context. First check if the business has specific locations, cities, or regions mentioned in the background. Only use other regions if the business location is not specified.",
      priority_rules: [
        "1. Analyze business background for location references (headquarters, offices, operational areas)",
        "2. Use exact business location or nearby major city if found in context", 
        "3. Stay within reasonable proximity to business location when mentioned",
        "4. Only expand to major business hubs (Madrid, Barcelona) if NO location specified in background"
      ],
      note: "Location determination must prioritize business context over general market analysis"
    },
    output_requirements: {
      mandatory_fields: ["target_city", "target_region", "business_research_topic", "business_types"],
      business_types_format: {
        required_fields: ["name", "description", "relevance", "market_potential"],
        count: maxBusinessTypes,
        note: "Each business type must be a detailed object with all required fields populated"
      }
    }
  };
  
  const command = CommandFactory.createCommand({
    task: "research business types for regional market analysis",
    userId: userId,
    agentId: agentId,
    site_id: siteId,
    description: `Research and identify ${maxBusinessTypes} business types ${region && region !== "to be determined by agent" ? `in ${region}` : 'in optimal target region'} based on ${businessResearchTopic}. Determine location from business background and focus on businesses with lead generation potential. CRITICAL: Return results in the exact format specified in the targets configuration with business_types array.`,
    targets: [targetConfig],
    tools,
    context: contextMessage + `\n\nCRITICAL OUTPUT FORMAT REQUIREMENT:\nYou MUST return your results in this exact JSON structure:\n{\n  "target_city": "determined_city_name",\n  "target_region": "determined_region_name", \n  "business_research_topic": "your_refined_topic",\n  "business_types": [\n    {\n      "name": "Business Type Name",\n      "description": "Detailed description of the business type",\n      "relevance": "Why this business type is relevant to the region",\n      "market_potential": "Assessment of market potential and opportunities"\n    }\n  ]\n}\n\nDO NOT return business types in any other format or field name. The business_types array is MANDATORY and must contain exactly ${maxBusinessTypes} business type objects.`,
    supervisor: [
      {
        agent_role: "business_market_analyst",
        status: "not_initialized"
      },
      {
        agent_role: "regional_business_researcher",
        status: "not_initialized"
      }
    ],
    model: "gpt-4.1",
    modelType: "openai",
    metadata: webhook ? { 
      webhook_url: webhook.url,
      webhook_secret: webhook.secret,
      webhook_metadata: webhook.metadata,
      business_research_topic: businessResearchTopic,
      target_region: region,
      base_business_type: businessType,
      keywords: keywords
    } : {
      business_research_topic: businessResearchTopic,
      target_region: region,
      base_business_type: businessType,
      keywords: keywords
    }
  } as any);
  
  // Enviar comando para procesamiento
  const internalCommandId = await commandService.submitCommand(command);
  console.log(`📝 Comando de investigación de tipos de negocios creado con internal ID: ${internalCommandId}`);
  
  return internalCommandId;
}

/**
 * Función para extraer tipos de negocios determinados por el agente de los resultados del comando
 */
export function extractBusinessTypeResults(executedCommand: any, businessResearchTopic: string): {
  businessTypes: any[],
  determinedTopic: string,
  determinedCity: string | null,
  determinedRegion: string | null
} {
  const results = executedCommand.results || [];
  
  console.log(`🔍 DEBUG: Analizando ${results.length} resultados del comando`);
  
  // Log detallado de la estructura de resultados para debugging
  results.forEach((result: any, index: number) => {
    console.log(`📋 Resultado ${index}:`, {
      keys: Object.keys(result),
      hasBusinessTypes: !!result.business_types,
      businessTypesLength: result.business_types ? result.business_types.length : 0,
      hasIdentifiedBusinessTypes: !!result.identified_business_types,
      hasBusinessAnalysis: !!result.business_analysis,
      hasContent: !!result.content,
      type: result.type,
      // Mostrar sample del contenido si existe
      contentSample: result.content ? JSON.stringify(result.content).substring(0, 200) : null
    });
  });
  
  let businessTypes: any[] = [];
  
  // Método 1: Buscar resultados que contengan tipos de negocios directamente
  const businessTypeResults = results.filter((r: any) => 
    r.business_types && Array.isArray(r.business_types) && r.business_types.length > 0
  );
  
  if (businessTypeResults.length > 0) {
    console.log(`✅ Encontrados ${businessTypeResults.length} resultados con business_types directos`);
    businessTypes = businessTypeResults.flatMap((r: any) => r.business_types);
  } else {
    console.log(`⚠️ No se encontraron resultados con business_types directos, buscando en campos alternativos...`);
    
    // Método 2: Buscar en campos alternativos
    results.forEach((r: any) => {
      if (r.BUSINESS_TYPES_OUTPUT && Array.isArray(r.BUSINESS_TYPES_OUTPUT)) {
        console.log(`📋 Encontrados business types en BUSINESS_TYPES_OUTPUT: ${r.BUSINESS_TYPES_OUTPUT.length}`);
        businessTypes.push(...r.BUSINESS_TYPES_OUTPUT);
      } else if (r.identified_business_types && Array.isArray(r.identified_business_types)) {
        console.log(`📋 Encontrados business types en identified_business_types: ${r.identified_business_types.length}`);
        businessTypes.push(...r.identified_business_types);
      } else if (r.business_analysis && r.business_analysis.types) {
        console.log(`📋 Encontrados business types en business_analysis.types: ${r.business_analysis.types.length}`);
        businessTypes.push(...r.business_analysis.types);
      } else if (r.content && typeof r.content === 'object') {
        // Método 3: Buscar en content si es objeto
        if (r.content.business_types && Array.isArray(r.content.business_types)) {
          console.log(`📋 Encontrados business types en content.business_types: ${r.content.business_types.length}`);
          businessTypes.push(...r.content.business_types);
        } else if (r.content.identified_business_types && Array.isArray(r.content.identified_business_types)) {
          console.log(`📋 Encontrados business types en content.identified_business_types: ${r.content.identified_business_types.length}`);
          businessTypes.push(...r.content.identified_business_types);
        } else if (r.content.recommendations && Array.isArray(r.content.recommendations)) {
          console.log(`📋 Encontrados business types en content.recommendations: ${r.content.recommendations.length}`);
          businessTypes.push(...r.content.recommendations);
        }
      } else if (r.content && typeof r.content === 'string') {
        // Método 4: Intentar parsear content si es string JSON
        try {
          const parsedContent = JSON.parse(r.content);
          if (parsedContent.business_types && Array.isArray(parsedContent.business_types)) {
            console.log(`📋 Encontrados business types en content JSON parseado: ${parsedContent.business_types.length}`);
            businessTypes.push(...parsedContent.business_types);
          }
                 } catch (e: any) {
           console.log(`⚠️ No se pudo parsear content como JSON: ${e.message}`);
        }
      }
    });
  }
  
  // Método 5: Buscar en targets si no encontramos nada
  if (businessTypes.length === 0) {
    console.log(`⚠️ No se encontraron business types en métodos anteriores, buscando en targets...`);
    
    // Buscar en targets del comando original
    if (executedCommand.targets && Array.isArray(executedCommand.targets)) {
      executedCommand.targets.forEach((target: any) => {
        if (target.business_types && Array.isArray(target.business_types)) {
          console.log(`📋 Encontrados business types en targets: ${target.business_types.length}`);
          businessTypes.push(...target.business_types);
        }
      });
    }
  }
  
  // Método 6: Buscar business types en cualquier array que contenga objetos con 'name' y 'description'
  if (businessTypes.length === 0) {
    console.log(`⚠️ Último intento: buscando arrays con estructura de business types...`);
    
    results.forEach((r: any) => {
      // Buscar en cualquier propiedad que sea array
      Object.keys(r).forEach(key => {
        if (Array.isArray(r[key]) && r[key].length > 0) {
          // Verificar si los elementos del array parecen business types
          const firstItem = r[key][0];
          if (firstItem && typeof firstItem === 'object' && 
              (firstItem.name || firstItem.business_name || firstItem.type)) {
            console.log(`📋 Encontrados posibles business types en ${key}: ${r[key].length}`);
            businessTypes.push(...r[key]);
          }
        }
      });
    });
  }
  
  // Normalizar business types para asegurar estructura consistente
  businessTypes = businessTypes.map((bt: any) => {
    if (typeof bt === 'string') {
      return { name: bt, description: '', relevance: '', market_potential: '' };
    } else if (typeof bt === 'object' && bt !== null) {
      return {
        name: bt.name || bt.business_name || bt.business_type_name || bt.type || 'Unknown Business Type',
        description: bt.description || bt.desc || bt.summary || '',
        relevance: bt.relevance || bt.relevance_to_region || bt.why_relevant || bt.region_fit || '',
        market_potential: bt.market_potential || bt.market_potential_indicators || bt.potential || bt.opportunity || ''
      };
    }
    return bt;
  });
  
  // Post-procesamiento para market_potential_indicators que viene como array
  businessTypes = businessTypes.map((bt: any) => {
    if (Array.isArray(bt.market_potential)) {
      bt.market_potential = bt.market_potential.join(', ');
    }
    return bt;
  });
  
  // Extraer el topic, city y region determinados por el agente
  const determinedTopic = results.find((r: any) => r.business_research_topic)?.business_research_topic || businessResearchTopic;
  
  // Extraer ciudad y región como en extractCommandResults
  const targetResult = results.find((r: any) => r.target_city !== undefined || r.target_region !== undefined) || results[0];
  const determinedCity = targetResult?.target_city || null;
  const determinedRegion = targetResult?.target_region || null;
  
  console.log(`🎯 RESULTADO FINAL: ${businessTypes.length} business types extraídos`);
  console.log(`🎯 Topic determinado: ${determinedTopic}`);
  console.log(`🎯 Ciudad determinada: ${determinedCity}, Región determinada: ${determinedRegion}`);
  
  if (businessTypes.length > 0) {
    console.log(`✅ Business types encontrados:`);
    businessTypes.forEach((bt, index) => {
      console.log(`  ${index + 1}. ${bt.name} - ${bt.description?.substring(0, 50)}...`);
    });
  } else {
    console.log(`❌ No se pudieron extraer business types de ninguna estructura`);
    console.log(`📊 Estructura completa de resultados para análisis:`, JSON.stringify(results, null, 2));
  }
  
  return {
    businessTypes,
    determinedTopic,
    determinedCity,
    determinedRegion
  };
} 