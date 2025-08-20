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
  
  // ESTRUCTURA SIMPLIFICADA: Solo los campos que realmente necesitamos en el resultado
  // Esto evita confusión y asegura consistencia entre target y results
  const targetConfig = {
    target_city: "to be determined by agent",
    target_region: "to be determined by agent", 
    target_country: "to be determined by agent",
    search_topic: searchTopic,
    leads_count: maxLeads
  };
  

  
  const command = CommandFactory.createCommand({
    task: "generate qualified sales leads",
    userId: userId,
    agentId: agentId,
    site_id: siteId,
    description: `Generate a lead reserach plan for ${maxLeads} qualified leads focusing on ${searchTopic}. Determine location from business background.`,
    targets: [targetConfig],
    tools,
    context: contextMessage + `

🎯 LOCATION DETERMINATION INSTRUCTIONS:
- Determine target_city, target_region, and target_country from business background/context
- If no specific location mentioned, use best judgment for business type
- Use SPECIFIC CITY SUBSECTIONS, not broad commercial regions
- Correct examples: "Zona Centro", "Colonia Roma", "Distrito Financiero", "Barrio Gótico"
- Incorrect examples: "Bajío", "Norte", "Sur", "Región Metropolitana"
- For large cities (>500k population): Always specify a city subsection using local naming conventions
- Previously searched cities: ${JSON.stringify(usedCities)}
- Previously searched regions: ${JSON.stringify(usedRegions)}

📊 EXPECTED OUTPUT STRUCTURE:
Return exactly the target structure with real values filled in:
{
  "target_city": "actual determined city name",
  "target_region": "actual determined region/subsection name", 
  "target_country": "actual determined country name",
  "search_topic": "refined search topic based on analysis",
  "leads_count": ${maxLeads},
  "segment_analysis": {
    "total_segments": actual number,
    "converted_leads_analyzed": actual number,
    "non_converted_leads_analyzed": actual number,
    "insights": "detailed insights from analysis"
  },
  "location_guidance": "explanation of location choice and strategy"
}`,
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
    model: "gpt-5-nano",
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
  determinedTopic: string,
  determinedCountry: string | null,
  determinedLeadsCount: number | null
} {
  const results = executedCommand.results || [];
  

  
  // Buscar el resultado que contenga los campos de ubicación
  const targetResult = results.find((r: any) => 
    r.target_city !== undefined || r.target_region !== undefined || r.target_country !== undefined
  ) || results[0];
  
  if (!targetResult) {
    return {
      determinedCity: null,
      determinedRegion: null,
      determinedTopic: searchTopic,
      determinedCountry: null,
      determinedLeadsCount: null
    };
  }
  
  // Extraer valores, manejando tanto strings como valores "to be determined"
  let determinedCity = targetResult?.target_city || null;
  let determinedRegion = targetResult?.target_region || null;
  let determinedCountry = targetResult?.target_country || null;
  const determinedTopic = targetResult?.search_topic || searchTopic;
  let determinedLeadsCount = targetResult?.leads_count || null;
  
  // Limpiar valores placeholder que el agente no pudo determinar
  if (determinedCity && (typeof determinedCity === 'string' && 
      (determinedCity.includes('to be determined') || determinedCity.includes('placeholder')))) {
    determinedCity = null;
  }
  
  if (determinedRegion && (typeof determinedRegion === 'string' && 
      (determinedRegion.includes('to be determined') || determinedRegion.includes('placeholder')))) {
    determinedRegion = null;
  }
  
  if (determinedCountry && (typeof determinedCountry === 'string' && 
      (determinedCountry.includes('to be determined') || determinedCountry.includes('placeholder')))) {
    determinedCountry = null;
  }
  
  // Validar leads_count como número
  if (determinedLeadsCount && typeof determinedLeadsCount === 'number' && determinedLeadsCount > 0) {
    // Mantener el valor si es válido
  } else {
    determinedLeadsCount = null;
  }
  
  console.log(`🎯 Valores determinados por el agente: city=${determinedCity}, region=${determinedRegion}, country=${determinedCountry}, topic=${determinedTopic}, leadsCount=${determinedLeadsCount}`);
  
  return {
    determinedCity,
    determinedRegion,
    determinedTopic,
    determinedCountry,
    determinedLeadsCount
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
    target_country: "Current objective country",
    target_city: "Current objective city",
    target_region: region === "to be determined by agent" ? null : region,
    business_type: businessType,
    keywords: keywords,
    business_research_topic: businessResearchTopic,
    business_types_count: maxBusinessTypes,
    business_types: [
      {
        segment_id: "unique_segment_identifier",
        description: "Detailed description of the business type", 
        name: "Business Type Name"
      }
    ]
  };
  
  const command = CommandFactory.createCommand({
    task: "research business types for regional market analysis",
    userId: userId,
    agentId: agentId,
    site_id: siteId,
    description: `Research and identify ${maxBusinessTypes} business types ${region && region !== "to be determined by agent" ? `in ${region}` : 'in optimal target region'} based on ${businessResearchTopic}. Determine location from business background and focus on businesses with lead generation potential. CRITICAL: Return results in the exact format specified in the targets configuration with business_types array.`,
    targets: [targetConfig],
    tools,
    context: contextMessage + `\n\nCRITICAL OUTPUT FORMAT REQUIREMENT:\nYou MUST return your results in this exact JSON structure:\n{\n  "target_city": "determined_city_name",\n  "target_region": "determined_region_name",\n  "target_country": "determined_country_name", \n  "business_research_topic": "your_refined_topic",\n  "business_types": [\n    {\n      "segment_id": "unique_segment_identifier",\n      "description": "Detailed description of the business type",\n      "name": "Business Type Name"\n    }\n  ]\n}\n\n🏙️ REGION SPECIFICATION CRITICAL REQUIREMENT:\nThe "target_region" field MUST be a SPECIFIC CITY SUBSECTION, not a broad commercial region.\n\nCORRECT REGION EXAMPLES:\n✅ "Zona Centro" (city center area)\n✅ "Colonia Roma" (specific neighborhood/colony)\n✅ "Distrito Financiero" (specific district)\n✅ "Barrio Gótico" (specific neighborhood)\n✅ "Centro Histórico" (historic city center)\n\nINCORRECT REGION EXAMPLES (DO NOT USE):\n❌ "Bajío" (too broad, commercial region)\n❌ "Norte" (too vague, directional region)\n❌ "Sur" (too vague, directional region)\n❌ "Región Metropolitana" (too broad)\n\nFor large cities (>500k population), ALWAYS specify a city subsection using local naming conventions.\n\nDO NOT return business types in any other format or field name. The business_types array is MANDATORY and must contain exactly ${maxBusinessTypes} business type objects.`,
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
    model: "gpt-5-nano",
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
  determinedRegion: string | null,
  determinedCountry: string | null,
  determinedSegmentId: string | null
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
      return { name: bt, description: '' };
    } else if (typeof bt === 'object' && bt !== null) {
      return {
        name: bt.name || bt.business_name || bt.business_type_name || bt.type || 'Unknown Business Type',
        description: bt.description || bt.desc || bt.summary || ''
      };
    }
    return bt;
  });
  
  // Post-procesamiento para campos que pueden venir como array
  businessTypes = businessTypes.map((bt: any) => {
    // No post-processing needed for current fields
    return bt;
  });
  
  // Extraer el topic, city y region determinados por el agente
  const determinedTopic = results.find((r: any) => r.business_research_topic)?.business_research_topic || businessResearchTopic;
  
  // Extraer ciudad y región como en extractCommandResults
  const targetResult = results.find((r: any) => r.target_city !== undefined || r.target_region !== undefined || r.target_country !== undefined) || results[0];
  
  // DEBUG: Logging detallado para entender por qué target_city puede ser null
  console.log(`🔍 DEBUG target_city extraction:`);
  console.log(`  - Total results: ${results.length}`);
  console.log(`  - Looking for target_city/target_region/target_country in results...`);
  
  results.forEach((r: any, index: number) => {
    console.log(`  - Result ${index}:`);
    console.log(`    - Has target_city: ${r.target_city !== undefined} (value: ${r.target_city})`);
    console.log(`    - Has target_region: ${r.target_region !== undefined} (value: ${r.target_region})`);
    console.log(`    - Has target_country: ${r.target_country !== undefined} (value: ${r.target_country})`);
    console.log(`    - All keys: ${Object.keys(r).join(', ')}`);
  });
  
  console.log(`  - Selected targetResult: ${targetResult ? 'Found' : 'Using first result'}`);
  if (targetResult) {
    console.log(`    - target_city: ${targetResult.target_city}`);
    console.log(`    - target_region: ${targetResult.target_region}`);
    console.log(`    - target_country: ${targetResult.target_country}`);
  }
  
  const determinedCity = targetResult?.target_city || null;
  const determinedRegion = targetResult?.target_region || null;
  const determinedCountry = targetResult?.target_country || null;
  
  // Extraer segment_id determinado por el agente
  const determinedSegmentId = targetResult?.target_segment_id || 
                             results.find((r: any) => r.target_segment_id)?.target_segment_id || 
                             null;
  
  console.log(`🎯 RESULTADO FINAL: ${businessTypes.length} business types extraídos`);
  console.log(`🎯 Topic determinado: ${determinedTopic}`);
  console.log(`🎯 Ciudad determinada: ${determinedCity}, Región determinada: ${determinedRegion}, País determinado: ${determinedCountry}`);
  console.log(`🎯 Segmento determinado: ${determinedSegmentId}`);
  
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
    determinedRegion,
    determinedCountry,
    determinedSegmentId
  };
} 