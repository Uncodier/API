/**
 * Funciones para generar tipos de negocios y temas de investigación basados en análisis regional
 */

export interface RegionInsights {
  popularIndustries?: string[];
  growingBusinessTypes?: string[];
  marketTrends?: string[];
  economicData?: {
    population?: number;
    avgIncome?: number;
    businessDensity?: number;
  };
  competitorAnalysis?: {
    dominantTypes?: string[];
    gaps?: string[];
  };
}

/**
 * Genera un topic de investigación de negocios basado en la región y contexto
 */
export function generateBusinessResearchTopic(
  region: string,
  businessType: string,
  keywords: string[],
  regionInsights: RegionInsights
): string {
  let topic = "";
  
  if (businessType && businessType.trim() !== '') {
    topic = `${businessType.toLowerCase()} businesses and similar service providers in ${region}`;
  } else if (keywords.length > 0) {
    topic = `businesses related to ${keywords.join(', ')} in ${region}`;
  } else {
    topic = `emerging business opportunities and established industries in ${region}`;
  }
  
  // Enriquecer con insights de la región
  if (regionInsights.popularIndustries && regionInsights.popularIndustries.length > 0) {
    topic += ` with focus on ${regionInsights.popularIndustries.slice(0, 3).join(', ')} sectors`;
  }
  
  return topic;
}

/**
 * Genera prompts para encontrar tipos de negocios específicos
 */
export function generateBusinessTypePrompts(
  region: string,
  businessType: string,
  keywords: string[],
  regionInsights: RegionInsights
): string {
  let prompts = `BUSINESS TYPE RESEARCH GENERATION:\n`;
  if (region === "to be determined by agent") {
    prompts += `🎯 CRITICAL: FIRST determine target region by analyzing business background/context for location references.\n`;
    prompts += `MANDATORY: Prioritize any business location mentioned in the background over general market considerations.\n`;
    prompts += `Generate specific business types relevant to the determined region based on business context.\n\n`;
  } else {
    prompts += `Generate specific business types and industries that would be relevant to research in ${region}.\n\n`;
  }
  
  if (businessType && businessType.trim() !== '') {
    prompts += `BASE BUSINESS TYPE PROVIDED: ${businessType}\n`;
    prompts += `Find similar business types, variations, and related industries that serve similar markets or customer needs.\n\n`;
  }
  
  if (keywords.length > 0) {
    prompts += `KEYWORDS TO CONSIDER: ${keywords.join(', ')}\n`;
    prompts += `Generate business types that incorporate or relate to these keywords.\n\n`;
  }
  
  if (regionInsights.popularIndustries && regionInsights.popularIndustries.length > 0) {
    prompts += `POPULAR INDUSTRIES IN ${region.toUpperCase()}: ${regionInsights.popularIndustries.join(', ')}\n`;
    prompts += `Consider how these established industries create opportunities for related business types.\n\n`;
  }
  
  if (regionInsights.growingBusinessTypes && regionInsights.growingBusinessTypes.length > 0) {
    prompts += `GROWING BUSINESS TYPES IN REGION: ${regionInsights.growingBusinessTypes.join(', ')}\n`;
    prompts += `Include these trending business types and their variations.\n\n`;
  }
  
  if (regionInsights.competitorAnalysis?.gaps && regionInsights.competitorAnalysis.gaps.length > 0) {
    prompts += `MARKET GAPS IDENTIFIED: ${regionInsights.competitorAnalysis.gaps.join(', ')}\n`;
    prompts += `Consider business types that could fill these gaps in the market.\n\n`;
  }
  
  prompts += `BUSINESS TYPE GENERATION GUIDELINES:\n`;
  prompts += `🎯 CRITICAL FOCUS: BUSINESS MODEL & AWARENESS TACTICS\n`;
  prompts += `1. Focus on business types that would have publicly available contact information\n`;
  prompts += `2. Include both established and emerging business categories\n`;
  prompts += `3. Consider business-to-business (B2B) services that support other businesses\n`;
  prompts += `4. Include professional services, consulting, and specialized service providers\n`;
  prompts += `5. Consider seasonal or event-based business types relevant to the region\n`;
  prompts += `6. Include franchise opportunities and multi-location business types\n`;
  prompts += `7. Consider technology-enabled service businesses\n`;
  prompts += `8. Include businesses that serve the local community and region\n\n`;
  
  prompts += `💼 SPECIAL ATTENTION: BUSINESS MODEL ANALYSIS\n`;
  prompts += `For each business type, pay special attention to:\n`;
  prompts += `- Revenue generation models (subscription, one-time, commission, hybrid)\n`;
  prompts += `- Customer acquisition strategies and channels\n`;
  prompts += `- Scalability potential and growth models\n`;
  prompts += `- Operational structure and cost models\n`;
  prompts += `- Market positioning and competitive advantages\n`;
  prompts += `- Digital transformation opportunities\n\n`;
  
  prompts += `📢 SPECIAL ATTENTION: AWARENESS TACTICS\n`;
  prompts += `For each business type, consider their awareness generation tactics:\n`;
  prompts += `- Local marketing and community engagement strategies\n`;
  prompts += `- Digital marketing approaches (SEO, social media, content marketing)\n`;
  prompts += `- Traditional advertising channels they typically use\n`;
  prompts += `- Networking and partnership strategies\n`;
  prompts += `- Brand building and reputation management tactics\n`;
  prompts += `- Customer referral and word-of-mouth strategies\n`;
  prompts += `- Event marketing and trade show participation\n`;
  prompts += `- Content creation and thought leadership approaches\n\n`;
  
  prompts += `EXAMPLES OF BUSINESS TYPE VARIATIONS:\n`;
  prompts += `Instead of just "restaurant" → "fine dining restaurant", "fast-casual restaurant", "catering service", "food truck business"\n`;
  prompts += `Instead of just "retail" → "specialty retail store", "online retail with local pickup", "pop-up retail concept"\n`;
  prompts += `Instead of just "consulting" → "business strategy consulting", "digital marketing consulting", "HR consulting"\n\n`;
  
  prompts += `REGIONAL CONTEXT CONSIDERATIONS:\n`;
  prompts += `1. Consider the economic profile of ${region}\n`;
  prompts += `2. Include business types that serve the local demographics\n`;
  prompts += `3. Consider tourism and visitor-related businesses if applicable\n`;
  prompts += `4. Include businesses that support local industries\n`;
  prompts += `5. Consider regulatory or licensing requirements specific to the region\n\n`;
  
  prompts += `OUTPUT FORMAT:\n`;
  prompts += `Generate a diverse list of specific business types, each with:\n`;
  prompts += `- Clear business type name\n`;
  prompts += `- Brief description of what they do\n`;
  prompts += `- Why they're relevant to ${region}\n`;
  prompts += `- Business model characteristics and revenue strategies\n`;
  prompts += `- Typical awareness and marketing tactics they use\n`;
  prompts += `- Potential for having discoverable contact information\n`;
  
  return prompts;
}

/**
 * Genera el mensaje de contexto completo para la investigación de tipos de negocios
 */
export function generateBusinessTypeContextMessage(
  region: string,
  businessType: string,
  keywords: string[],
  regionInsights: RegionInsights,
  businessResearchTopic: string,
  businessTypePrompts: string,
  usedCities: string[],
  usedRegions: { [key: string]: string[] },
  maxBusinessTypes: number,
  availableSegments: any[],
  usedSegments: string[],
  usedSegmentsByRegion: { [key: string]: string[] },
  webhook?: { url: string }
): string {
  let contextMessage = `BUSINESS TYPE RESEARCH ANALYSIS\n\n`;
  
  if (region === "to be determined by agent") {
    contextMessage += `🎯 LOCATION PRIORITY DIRECTIVE:\n`;
    contextMessage += `CRITICAL: Before determining ANY target region, you MUST thoroughly analyze the business background/context.\n`;
    contextMessage += `MANDATORY LOCATION SEARCH PROCESS:\n`;
    contextMessage += `1. Scan ALL background information for business location clues\n`;
    contextMessage += `2. Look for: headquarters, offices, operational areas, service regions, geographical mentions\n`;
    contextMessage += `3. If business location found → Use that location or nearby major city\n`;
    contextMessage += `4. If NO business location found → Only then use major business hub (Madrid/Barcelona)\n`;
    contextMessage += `5. NEVER select random regions without checking business context first\n\n`;
    
    contextMessage += `TARGET REGION: To be determined by agent based on business background/context\n`;
    contextMessage += `CRITICAL PRIORITY RULES FOR REGION SELECTION:\n`;
    contextMessage += `1. ALWAYS prioritize business locations defined in the background/context\n`;
    contextMessage += `2. First check if there are specific locations, cities, or regions mentioned in the business background\n`;
    contextMessage += `3. Look for business headquarters, main offices, or operational areas\n`;
    contextMessage += `4. Only use other regions if no business location is specified in the background\n`;
    contextMessage += `5. Stay within reasonable proximity to the business location when mentioned\n`;
    contextMessage += `IMPORTANT: Analyze the business background thoroughly to find location references before determining target region.\n\n`;
    
    contextMessage += `🏙️ REGION SPECIFICATION REQUIREMENTS:\n`;
    contextMessage += `CRITICAL: When determining target_region, use SPECIFIC CITY SUBSECTIONS, not broad commercial regions.\n`;
    contextMessage += `CORRECT REGION TYPES (City Subsections):\n`;
    contextMessage += `✅ "Zona Centro" (city center area)\n`;
    contextMessage += `✅ "Colonia Roma" (specific neighborhood/colony)\n`;
    contextMessage += `✅ "Distrito Financiero" (specific district)\n`;
    contextMessage += `✅ "Barrio Gótico" (specific neighborhood)\n`;
    contextMessage += `✅ "Zona Industrial" (specific industrial area)\n`;
    contextMessage += `✅ "Centro Histórico" (historic city center)\n`;
    contextMessage += `✅ "Zona Comercial Norte" (specific commercial area within city)\n`;
    contextMessage += `✅ "Polígono Industrial Sur" (specific industrial polygon)\n\n`;
    
    contextMessage += `INCORRECT REGION TYPES (Broad Commercial Regions - DO NOT USE):\n`;
    contextMessage += `❌ "Bajío" (too broad, commercial region)\n`;
    contextMessage += `❌ "Norte" (too vague, directional region)\n`;
    contextMessage += `❌ "Sur" (too vague, directional region)\n`;
    contextMessage += `❌ "Región Metropolitana" (too broad)\n`;
    contextMessage += `❌ "Área Metropolitana" (too broad)\n`;
    contextMessage += `❌ "Zona Económica" (too broad)\n\n`;
    
    contextMessage += `🎯 REGION SELECTION EXAMPLES:\n`;
    contextMessage += `• Madrid → "Zona Centro", "Distrito Salamanca", "Barrio Malasaña"\n`;
    contextMessage += `• Barcelona → "Zona Eixample", "Barrio Gótico", "Distrito 22@"\n`;
    contextMessage += `• México DF → "Colonia Roma", "Zona Rosa", "Centro Histórico"\n`;
    contextMessage += `• Guadalajara → "Zona Centro", "Colonia Americana", "Distrito Puerta de Hierro"\n`;
    contextMessage += `• Monterrey → "Zona Centro", "Colonia del Valle", "Distrito Tecnológico"\n\n`;
    
    contextMessage += `📍 REGION DETERMINATION STRATEGY:\n`;
    contextMessage += `1. For LARGE CITIES (>500k population): Always specify a city subsection\n`;
    contextMessage += `2. For MEDIUM CITIES (100k-500k): Use specific areas when relevant\n`;
    contextMessage += `3. For SMALL CITIES (<100k): City name alone may be sufficient\n`;
    contextMessage += `4. ALWAYS prefer specific neighborhoods, districts, or zones within the city\n`;
    contextMessage += `5. Use local naming conventions (Colonia in Mexico, Barrio in Spain, etc.)\n\n`;
    
    contextMessage += `🚫 REGIONAL RESTRICTIONS:\n`;
    contextMessage += `CRITICAL: Consider regional restrictions available in your background settings.channels.locations.\n`;
    contextMessage += `MANDATORY LOCATION COMPLIANCE:\n`;
    contextMessage += `1. ONLY consider cities from ALLOWED locations (settings.channels.locations.allowed)\n`;
    contextMessage += `2. AVOID cities from RESTRICTED locations (settings.channels.locations.restricted)\n`;
    contextMessage += `3. If business context location conflicts with restrictions, prioritize ALLOWED locations nearby\n`;
    contextMessage += `4. If no business location found, select from ALLOWED locations only\n`;
    contextMessage += `5. NEVER select cities from restricted areas regardless of business context\n\n`;
  } else {
    contextMessage += `TARGET REGION: ${region}\n\n`;
    
    // Nuevas indicaciones para regiones especificadas
    contextMessage += `🎯 REGION ANALYSIS AND OPTIMIZATION:\n`;
    contextMessage += `CRITICAL: A specific region has been provided. Apply the following rules:\n\n`;
    
    contextMessage += `1. PRIORITY WEIGHT FOR SPECIFIED REGION:\n`;
    contextMessage += `   - The specified region "${region}" has HIGH PRIORITY and should be given weight\n`;
    contextMessage += `   - Focus business type research specifically on this region\n`;
    contextMessage += `   - Prioritize businesses that operate well in this specific geographical area\n`;
    contextMessage += `   - Consider local market characteristics, demographics, and business environment\n\n`;
    
    contextMessage += `2. BROAD REGION OPTIMIZATION (Continents/Countries):\n`;
    contextMessage += `   - If the region is very broad (continent, country, or large economic zone):\n`;
    contextMessage += `     * IDENTIFY the most strategic locations within that region for finding clients\n`;
    contextMessage += `     * SELECT major business hubs, economic centers, or capital cities\n`;
    contextMessage += `     * PRIORITIZE locations with high business density and strategic accounts\n`;
    contextMessage += `     * FOCUS on cities/areas known for business concentration and growth\n\n`;
    
    contextMessage += `   📍 STRATEGIC LOCATION SELECTION EXAMPLES:\n`;
    contextMessage += `   • If region = "España" → Focus on Madrid (financial center) or Barcelona (industrial/tech)\n`;
    contextMessage += `   • If region = "México" → Focus on Ciudad de México (capital) or Monterrey (industrial)\n`;
    contextMessage += `   • If region = "Europa" → Focus on Madrid, Barcelona, Milan, Frankfurt (business centers)\n`;
    contextMessage += `   • If region = "América Latina" → Focus on CDMX, São Paulo, Buenos Aires (economic hubs)\n`;
    contextMessage += `   • If region = "Estados Unidos" → Focus on New York, Los Angeles, Chicago (major markets)\n\n`;
    
    contextMessage += `3. STRATEGIC ACCOUNT TARGETING:\n`;
    contextMessage += `   - For broad regions, select locations that maximize strategic account potential\n`;
    contextMessage += `   - Prioritize business districts, financial centers, and corporate headquarters areas\n`;
    contextMessage += `   - Consider locations with high-value business concentration\n`;
    contextMessage += `   - Focus on areas where decision-makers and key accounts are likely located\n\n`;
    
    contextMessage += `4. LOCATION REFINEMENT REQUIREMENTS:\n`;
    contextMessage += `   - If the specified region is broader than a city, you MUST determine a specific target city\n`;
    contextMessage += `   - Set target_city to the most strategic business location within the region\n`;
    contextMessage += `   - Set target_region to a specific business district/area within that city\n`;
    contextMessage += `   - Provide clear reasoning for the location selection in your response\n\n`;
    
    contextMessage += `🚫 REGIONAL RESTRICTIONS FOR SPECIFIED REGIONS:\n`;
    contextMessage += `CRITICAL: Even with a specified region, respect location restrictions from settings.channels.locations.\n`;
    contextMessage += `MANDATORY COMPLIANCE:\n`;
    contextMessage += `1. If specified region is in RESTRICTED locations → Find nearest ALLOWED location instead\n`;
    contextMessage += `2. If specified region is in ALLOWED locations → Proceed with that region\n`;
    contextMessage += `3. If specified region is broader (country/continent) → Select cities ONLY from ALLOWED locations\n`;
    contextMessage += `4. NEVER compromise location restrictions for any reason\n`;
    contextMessage += `5. Always prioritize ALLOWED locations over specified regions if conflict exists\n\n`;
  }
  
  if (businessType && businessType.trim() !== '') {
    contextMessage += `BASE BUSINESS TYPE: ${businessType}\n`;
  }
  
  if (keywords.length > 0) {
    contextMessage += `KEYWORDS: ${keywords.join(', ')}\n`;
  }
  
  contextMessage += `BUSINESS TYPES REQUESTED: ${maxBusinessTypes}\n\n`;
  
  // Información de segmentos disponibles
  if (availableSegments && availableSegments.length > 0) {
    contextMessage += `AVAILABLE SEGMENTS FOR TARGETING:\n`;
    availableSegments.forEach((segment, index) => {
      contextMessage += `${index + 1}. ${segment.name}\n`;
      if (segment.description) contextMessage += `   Description: ${segment.description}\n`;
      if (segment.audience) contextMessage += `   Audience: ${segment.audience}\n`;
      if (segment.size) contextMessage += `   Size: ${segment.size}\n`;
      contextMessage += `   Segment ID: ${segment.id}\n`;
    });
    contextMessage += `\n`;
    
    // Información sobre segmentos previamente utilizados
    if (usedSegments && usedSegments.length > 0) {
      contextMessage += `PREVIOUSLY USED SEGMENTS (GLOBAL): ${usedSegments.join(', ')}\n`;
    }
    
    // Información específica por región
    const currentRegion = region !== "to be determined by agent" ? region : null;
    if (currentRegion && usedSegmentsByRegion && usedSegmentsByRegion[currentRegion]) {
      contextMessage += `PREVIOUSLY USED SEGMENTS IN ${currentRegion}: ${usedSegmentsByRegion[currentRegion].join(', ')}\n`;
    }
    
    // Mostrar histórico de uso por región
    if (usedSegmentsByRegion && Object.keys(usedSegmentsByRegion).length > 0) {
      contextMessage += `SEGMENT USAGE HISTORY BY REGION:\n`;
      Object.entries(usedSegmentsByRegion).forEach(([regionName, segments]) => {
        contextMessage += `  ${regionName}: ${segments.join(', ')}\n`;
      });
    }
    
    contextMessage += `\nSEGMENT SELECTION INSTRUCTIONS:\n`;
    contextMessage += `1. MANDATORY: You MUST select ONE segment from the available segments above\n`;
    contextMessage += `2. Choose the segment that best matches the business types you will identify\n`;
    contextMessage += `3. Include the selected segment ID in your response as 'target_segment_id'\n`;
    contextMessage += `4. PRIORITIZE segments that haven't been used in the target region (avoid those in PREVIOUSLY USED SEGMENTS IN [REGION])\n`;
    contextMessage += `5. If all segments have been used in the target region, prefer the least recently used segment\n`;
    contextMessage += `6. Consider the segment's audience and size when making your selection\n\n`;
  } else {
    contextMessage += `NO SEGMENTS AVAILABLE - Agent should focus on general business type research\n\n`;
  }
  
  // Información de la región
  contextMessage += `REGION INSIGHTS:\n`;
  
  if (regionInsights.popularIndustries && regionInsights.popularIndustries.length > 0) {
    contextMessage += `Popular Industries: ${regionInsights.popularIndustries.join(', ')}\n`;
  }
  
  if (regionInsights.growingBusinessTypes && regionInsights.growingBusinessTypes.length > 0) {
    contextMessage += `Growing Business Types: ${regionInsights.growingBusinessTypes.join(', ')}\n`;
  }
  
  if (regionInsights.marketTrends && regionInsights.marketTrends.length > 0) {
    contextMessage += `Market Trends: ${regionInsights.marketTrends.join(', ')}\n`;
  }
  
  if (regionInsights.economicData) {
    contextMessage += `Economic Data:\n`;
    if (regionInsights.economicData.population) {
      contextMessage += `  Population: ${regionInsights.economicData.population.toLocaleString()}\n`;
    }
    if (regionInsights.economicData.avgIncome) {
      contextMessage += `  Average Income: $${regionInsights.economicData.avgIncome.toLocaleString()}\n`;
    }
    if (regionInsights.economicData.businessDensity) {
      contextMessage += `  Business Density: ${regionInsights.economicData.businessDensity}\n`;
    }
  }
  
  if (regionInsights.competitorAnalysis) {
    contextMessage += `Market Analysis:\n`;
    if (regionInsights.competitorAnalysis.dominantTypes) {
      contextMessage += `  Dominant Business Types: ${regionInsights.competitorAnalysis.dominantTypes.join(', ')}\n`;
    }
    if (regionInsights.competitorAnalysis.gaps) {
      contextMessage += `  Market Gaps: ${regionInsights.competitorAnalysis.gaps.join(', ')}\n`;
    }
  }
  
  contextMessage += `\n`;
  
  // Historial de búsquedas
  if (usedCities.length > 0) {
    contextMessage += `PREVIOUSLY SEARCHED CITIES: ${usedCities.join(', ')}\n`;
  }
  
  if (Object.keys(usedRegions).length > 0) {
    contextMessage += `PREVIOUSLY SEARCHED REGIONS:\n`;
    Object.entries(usedRegions).forEach(([city, regions]) => {
      contextMessage += `  ${city}: ${regions.join(', ')}\n`;
    });
  }
  
  contextMessage += `\n`;
  
  // Research topic y prompts
  contextMessage += `BUSINESS RESEARCH TOPIC: ${businessResearchTopic}\n\n`;
  contextMessage += `${businessTypePrompts}\n\n`;
  
  // Instrucciones específicas
  contextMessage += `SPECIFIC INSTRUCTIONS:\n`;
  if (region === "to be determined by agent") {
    contextMessage += `1. FIRST: Carefully analyze the business background/context for ANY location references:\n`;
    contextMessage += `   - Business headquarters or main office location\n`;
    contextMessage += `   - Operational areas or service regions\n`;
    contextMessage += `   - Cities or regions mentioned in business description\n`;
    contextMessage += `   - Target market geographical areas\n`;
    contextMessage += `   - Any geographical context in the background information\n`;
    contextMessage += `2. CRITICAL: Check location restrictions (settings.channels.locations) BEFORE setting target location\n`;
    contextMessage += `   - ONLY select from ALLOWED locations\n`;
    contextMessage += `   - NEVER select from RESTRICTED locations\n`;
    contextMessage += `3. MANDATORY: Set target_city and target_region based on business location found in step 1 + restrictions\n`;
    contextMessage += `   - If business location found AND in allowed areas: Use that exact location or nearby major city\n`;
    contextMessage += `   - If business location found BUT in restricted areas: Use nearest allowed location\n`;
    contextMessage += `   - If NO business location in context: Use major allowed business hub\n`;
    contextMessage += `   - CRITICAL: target_region must be a specific city subsection (Zona, Colonia, Distrito, Barrio)\n`;
    contextMessage += `4. Generate ${maxBusinessTypes} distinct business types relevant to the determined region\n`;
  } else {
    contextMessage += `1. CRITICAL: Verify specified region compliance with location restrictions (settings.channels.locations)\n`;
    contextMessage += `   - If ${region} is in allowed locations: Proceed with region\n`;
    contextMessage += `   - If ${region} is in restricted locations: Select nearest allowed location instead\n`;
    contextMessage += `2. Generate ${maxBusinessTypes} distinct business types relevant to the compliant region\n`;
  }
  contextMessage += `${region === "to be determined by agent" ? '5' : '3'}. Focus on business types that would have publicly available contact information\n`;
  contextMessage += `${region === "to be determined by agent" ? '6' : '4'}. Include both established and emerging business categories\n`;
  contextMessage += `${region === "to be determined by agent" ? '7' : '5'}. Consider the regional economic context and demographics\n`;
  contextMessage += `${region === "to be determined by agent" ? '8' : '6'}. Ensure diversity in business types (avoid too many similar businesses)\n`;
  contextMessage += `${region === "to be determined by agent" ? '9' : '7'}. Include business-to-business services that support other businesses\n`;
  contextMessage += `${region === "to be determined by agent" ? '10' : '8'}. Consider seasonal or event-based business opportunities\n`;
  
  // Instrucciones específicas para incluir segment_id en el output
  if (availableSegments && availableSegments.length > 0) {
    contextMessage += `${region === "to be determined by agent" ? '11' : '9'}. CRITICAL: Include 'target_segment_id' in your response with the ID of the selected segment\n`;
  }
  contextMessage += `${region === "to be determined by agent" ? '12' : '10'}. Include businesses that serve both local and regional markets\n`;
  contextMessage += `${region === "to be determined by agent" ? '13' : '11'}. 🎯 PRIORITIZE analysis of business models and awareness tactics for each business type\n`;
  contextMessage += `${region === "to be determined by agent" ? '14' : '12'}. 💼 Analyze revenue models, customer acquisition, and scalability for each type\n`;
  contextMessage += `${region === "to be determined by agent" ? '15' : '13'}. 📢 Consider how each business type generates awareness and attracts customers\n\n`;
  
  contextMessage += `EXPECTED OUTPUT:\n`;
  if (region === "to be determined by agent") {
    contextMessage += `MANDATORY LOCATION OUTPUT:\n`;
    contextMessage += `- target_city: Determined target city (with explanation of how found)\n`;
    contextMessage += `- target_region: Determined target region - MUST be specific city subsection (e.g., "Zona Centro", "Colonia Roma", "Distrito Salamanca")\n`;
    contextMessage += `- location_source: "Found in business context: [specific reference]" OR "No business location found, using business hub"\n\n`;
    contextMessage += `⚠️ REGION OUTPUT REQUIREMENTS:\n`;
    contextMessage += `- Use SPECIFIC neighborhoods, districts, or zones within the target city\n`;
    contextMessage += `- Follow local naming conventions (Colonia, Barrio, Zona, Distrito)\n`;
    contextMessage += `- DO NOT use broad commercial regions like "Bajío", "Norte", "Sur"\n`;
    contextMessage += `- For large cities, ALWAYS specify a city subsection\n\n`;
    contextMessage += `BUSINESS TYPES OUTPUT:\n`;
  }
  contextMessage += `A list of specific business types with:\n`;
  contextMessage += `- Business type name\n`;
  contextMessage += `- Brief description\n`;
  contextMessage += `- Relevance to ${region === "to be determined by agent" ? 'the determined region' : region}\n`;
  contextMessage += `- Market potential indicators\n`;
  
  if (webhook) {
    contextMessage += `\nWEBHOOK NOTIFICATION:\n`;
    contextMessage += `Send results to: ${webhook.url}\n`;
  }
  
  contextMessage += `\n🚨 CRITICAL BUSINESS TYPE SEARCH RESTRICTION:\n`;
  contextMessage += `MANDATORY: Focus ONLY on variations and synonyms of the SAME business type for the selected segment.\n`;
  contextMessage += `DO NOT generate completely different business types that would complicate Google Maps searches.\n\n`;
  contextMessage += `✅ CORRECT APPROACH - Same type with different terms:\n`;
  contextMessage += `• For Marketing Agencies: "Agencias de marketing", "Agencias de publicidad", "Agencias de desarrollo web", "Consultores de marketing digital"\n`;
  contextMessage += `• For Restaurants: "Restaurantes", "Restaurantes de comida rápida", "Restaurantes de cocina local", "Comedores"\n`;
  contextMessage += `• For Consultants: "Consultores", "Asesores", "Consultores empresariales", "Servicios de consultoría"\n\n`;
  contextMessage += `❌ INCORRECT APPROACH - Mixing different business types:\n`;
  contextMessage += `• Do NOT mix: "Agencias de marketing" + "Ferreterías" + "Clínicas dentales"\n`;
  contextMessage += `• Do NOT combine unrelated industries in the same search segment\n\n`;
  contextMessage += `🎯 FOCUS STRATEGY:\n`;
  contextMessage += `1. Select ONE main business category for the segment\n`;
  contextMessage += `2. Generate ONLY variations, synonyms, and related terms for that same category\n`;
  contextMessage += `3. This ensures efficient and accurate Google Maps business discovery\n`;
  contextMessage += `4. Different search terms but same business essence for better lead generation results\n\n`;
  
  return contextMessage;
} 