/**
 * Funciones para generar prompts de búsqueda dinámicos basados en análisis de segmentos y leads
 */

export interface LeadData {
  company?: {
    industry?: string;
    name?: string;
  };
  position?: string;
  segment_name?: string;
  name?: string;
  address?: {
    city?: string;
  };
  status?: string;
}

export interface SegmentData {
  id: string;
  name: string;
  description?: string;
  audience?: string;
  size?: number;
}

/**
 * Genera un topic de búsqueda basado en los segmentos y leads convertidos
 */
export function generateSearchTopic(segments: SegmentData[], convertedLeads: LeadData[]): string {
  if (segments.length === 0) {
    return "local business owners and service company directors contact";
  }
  
  // Analizar las industrias y tipos de empresa más exitosos
  const industries: string[] = [];
  const positions: string[] = [];
  const companyTypes: string[] = [];
  
  // Extraer información de segmentos
  segments.forEach(segment => {
    if (segment.description) {
      industries.push(segment.description.toLowerCase());
    }
    if (segment.name) {
      companyTypes.push(segment.name.toLowerCase());
    }
  });
  
  // Extraer información de leads convertidos
  convertedLeads.forEach(lead => {
    if (lead.company && typeof lead.company === 'object') {
      if (lead.company.industry) {
        industries.push(lead.company.industry.toLowerCase());
      }
      if (lead.company.name) {
        companyTypes.push(lead.company.name.toLowerCase());
      }
    }
    if (lead.position) {
      positions.push(lead.position.toLowerCase());
    }
  });
  
  // Crear un topic base más descriptivo para el agente
  const uniqueIndustries = Array.from(new Set(industries)).slice(0, 3);
  const uniquePositions = Array.from(new Set(positions)).slice(0, 3);
  const uniqueCompanyTypes = Array.from(new Set(companyTypes)).slice(0, 3);
  
  // Generar descripción dinámica basada en los datos reales
  let searchTopic = "";
  
  if (uniqueIndustries.length > 0) {
    searchTopic += `business owners and decision-makers in ${uniqueIndustries.join(', ')} sectors`;
  }
  
  if (uniquePositions.length > 0) {
    const positionContext = uniquePositions.includes('ceo') || uniquePositions.includes('director') ? 
      'executive level contacts' : 'management level contacts';
    searchTopic += searchTopic ? ` focusing on ${positionContext}` : positionContext;
  }
  
  if (uniqueCompanyTypes.length > 0) {
    searchTopic += searchTopic ? ` in ${uniqueCompanyTypes.join(', ')} type companies` : 
      `${uniqueCompanyTypes.join(', ')} business contacts`;
  }
  
  return searchTopic || "local business owners and service company directors contact";
}

/**
 * Genera prompts dinámicos de búsqueda basados en patrones de leads exitosos
 */
export function generateSearchPrompts(segments: SegmentData[], convertedLeads: LeadData[]): string {
  const industries: string[] = [];
  const positions: string[] = [];
  const companyTypes: string[] = [];
  
  // Extraer información de segmentos y leads convertidos
  segments.forEach(segment => {
    if (segment.description) industries.push(segment.description.toLowerCase());
    if (segment.name) companyTypes.push(segment.name.toLowerCase());
  });
  
  convertedLeads.forEach(lead => {
    if (lead.company?.industry) industries.push(lead.company.industry.toLowerCase());
    if (lead.company?.name) companyTypes.push(lead.company.name.toLowerCase());
    if (lead.position) positions.push(lead.position.toLowerCase());
  });
  
  const uniqueIndustries = Array.from(new Set(industries));
  const uniquePositions = Array.from(new Set(positions));
  const uniqueCompanyTypes = Array.from(new Set(companyTypes));
  
  let searchPrompts = `DYNAMIC SEARCH TERM GENERATION:\n`;
  searchPrompts += `Based on the successful lead patterns, create highly specific and creative search terms that will find similar prospects.\n\n`;
  
  if (uniqueIndustries.length > 0) {
    searchPrompts += `SUCCESSFUL INDUSTRIES IDENTIFIED: ${uniqueIndustries.join(', ')}\n`;
    searchPrompts += `For each industry, generate 2-3 specific search terms that combine:\n`;
    searchPrompts += `- Industry-specific business types (be creative with sub-niches)\n`;
    searchPrompts += `- Decision-maker roles (owner, CEO, director, founder, partner)\n`;
    searchPrompts += `- Contact intent keywords (contact, email, phone, directory)\n`;
    searchPrompts += `Example approach: Instead of generic "restaurant owner", use "boutique restaurant owner", "farm-to-table restaurant CEO", "specialty cuisine restaurant proprietor"\n\n`;
  }
  
  if (uniquePositions.length > 0) {
    searchPrompts += `SUCCESSFUL POSITIONS IDENTIFIED: ${uniquePositions.join(', ')}\n`;
    searchPrompts += `Generate search terms targeting similar decision-making roles, but be creative with:\n`;
    searchPrompts += `- Alternative job titles in the same authority level\n`;
    searchPrompts += `- Industry-specific variations of these positions\n`;
    searchPrompts += `- Modern equivalents (e.g., "Chief Growth Officer" instead of just "CEO")\n\n`;
  }
  
  if (uniqueCompanyTypes.length > 0) {
    searchPrompts += `SUCCESSFUL COMPANY TYPES: ${uniqueCompanyTypes.join(', ')}\n`;
    searchPrompts += `Create search terms for similar business models, including:\n`;
    searchPrompts += `- Size variations (startup, SME, enterprise)\n`;
    searchPrompts += `- Business model variations (B2B, B2C, B2B2C, marketplace)\n`;
    searchPrompts += `- Geographic scope (local, regional, national)\n\n`;
  }
  
  searchPrompts += `SEARCH TERM CREATIVITY GUIDELINES:\n`;
  searchPrompts += `1. Combine industry + role + contact intent for maximum precision\n`;
  searchPrompts += `2. Use the language of the target city or region\n`;
  searchPrompts += `3. Include business size indicators (small, medium, enterprise)\n`;
  searchPrompts += `4. Add geographic relevance (local, regional, national scope)\n`;
  searchPrompts += `5. Consider seasonal or trending business types\n`;
  searchPrompts += `6. Include modern business models (SaaS, marketplace, platform)\n`;
  searchPrompts += `7. Use professional networking language (LinkedIn-style searches)\n`;
  searchPrompts += `8. Include contact verification terms (+email, +phone, +contact)\n\n`;
  
  searchPrompts += `AVOID GENERIC TERMS - BE SPECIFIC AND CREATIVE:\n`;
  searchPrompts += `❌ "business owner" → ✅ "boutique fitness studio owner"\n`;
  searchPrompts += `❌ "marketing company" → ✅ "performance marketing agency specializing in e-commerce"\n`;
  searchPrompts += `❌ "restaurant" → ✅ "organic farm-to-table restaurant with catering services"\n`;
  searchPrompts += `❌ "tech startup" → ✅ "B2B SaaS platform serving healthcare providers"\n\n`;
  

  searchPrompts += `IMPORTANT:`;
  searchPrompts += `1. Use question answer search terms to maximize results using SEO techniques`;
  searchPrompts += `2. Transform the business target segments into topics that would generate contact information`; 
  searchPrompts += `3. Choose the segments, business types, roles or position that would most probably be public in the business according to size and industry`;
  searchPrompts += `4. Prioritize lead quaility over quantity, example searching for buying signals, not just leads`;
  searchPrompts += `5. Search for buying signals, not just leads, example searching for "companies expadning in this region, or new restaurants in the area, or awards, fundings, etc"`;
  searchPrompts += `6. Search for the well known existing buisness and industries in the city or region"`;

  return searchPrompts;
}

/**
 * Genera el mensaje de contexto completo para el agente
 */
export function generateContextMessage(
  segments: SegmentData[], 
  convertedLeads: LeadData[], 
  nonConvertedLeads: LeadData[],
  searchTopic: string,
  searchPrompts: string,
  usedCities: string[],
  usedRegions: { [key: string]: string[] },
  maxLeads: number,
  webhook?: { url: string },
  business?: any
): string {
  let contextMessage = `LEAD SEGMENT ANALYSIS\n\n`;
  
  // Información del negocio objetivo (si se proporciona)
  if (business) {
    contextMessage += `TARGET BUSINESS CONTEXT:\n`;
    contextMessage += `This lead generation is focused on finding leads for a specific business:\n`;
    
    if (business.name) {
      contextMessage += `Business Name: ${business.name}\n`;
    }
    
    if (business.industry) {
      contextMessage += `Industry: ${business.industry}\n`;
    }
    
    if (business.description) {
      contextMessage += `Description: ${business.description}\n`;
    }
    
    if (business.location) {
      contextMessage += `Location: ${business.location}\n`;
    }
    
    if (business.target_market) {
      contextMessage += `Target Market: ${business.target_market}\n`;
    }
    
    if (business.services) {
      contextMessage += `Services: ${Array.isArray(business.services) ? business.services.join(', ') : business.services}\n`;
    }
    
    if (business.size) {
      contextMessage += `Business Size: ${business.size}\n`;
    }
    
    contextMessage += `\nIMPORTANT: Focus lead generation on prospects who would be potential customers for this specific business.\n`;
    contextMessage += `Consider the business location, industry, and target market when generating search strategies.\n\n`;
  }
  
  // Información de segmentos
  contextMessage += `ACTIVE SEGMENTS (${segments.length}):\n`;
  segments.forEach((segment, index) => {
    contextMessage += `${index + 1}. ${segment.name}\n`;
    if (segment.description) contextMessage += `   Description: ${segment.description}\n`;
    if (segment.audience) contextMessage += `   Audience: ${segment.audience}\n`;
    if (segment.size) contextMessage += `   Size: ${segment.size}\n`;
    contextMessage += `\n`;
  });
  
  // Análisis de leads convertidos
  contextMessage += `CONVERTED LEADS (${convertedLeads.length}):\n`;
  const convertedBySegment = convertedLeads.reduce((acc: any, lead) => {
    const segmentName = lead.segment_name || 'No segment';
    if (!acc[segmentName]) acc[segmentName] = [];
    acc[segmentName].push(lead);
    return acc;
  }, {});
  
  Object.entries(convertedBySegment).forEach(([segmentName, leads]: [string, any]) => {
    contextMessage += `\nSegment: ${segmentName} (${leads.length} converted)\n`;
    leads.slice(0, 3).forEach((lead: any, index: number) => {
      contextMessage += `  ${index + 1}. ${lead.name} - ${lead.position || 'N/A'}\n`;
      if (lead.company?.name) contextMessage += `     Company: ${lead.company.name}\n`;
      if (lead.company?.industry) contextMessage += `     Industry: ${lead.company.industry}\n`;
      if (lead.address?.city) contextMessage += `     City: ${lead.address.city}\n`;
    });
  });
  
  // Análisis de leads no convertidos
  contextMessage += `\nNON-CONVERTED LEADS (${nonConvertedLeads.length}):\n`;
  const nonConvertedBySegment = nonConvertedLeads.reduce((acc: any, lead) => {
    const segmentName = lead.segment_name || 'No segment';
    if (!acc[segmentName]) acc[segmentName] = [];
    acc[segmentName].push(lead);
    return acc;
  }, {});
  
  Object.entries(nonConvertedBySegment).forEach(([segmentName, leads]: [string, any]) => {
    contextMessage += `\nSegment: ${segmentName} (${leads.length} non-converted)\n`;
    leads.slice(0, 2).forEach((lead: any, index: number) => {
      contextMessage += `  ${index + 1}. ${lead.name} - ${lead.status}\n`;
      if (lead.company?.name) contextMessage += `     Company: ${lead.company.name}\n`;
    });
  });
  
  // Información de targeting dinámica
  contextMessage += `\nSEARCH CONFIGURATION:\n`;
  if (business) {
    contextMessage += `TARGET BUSINESS FOCUS: Generate leads for the specific business mentioned above.\n`;
    contextMessage += `CRITICAL: Focus on finding potential customers/clients who would use this business's services.\n`;
    if (business.location) {
      contextMessage += `PRIORITY LOCATION: ${business.location} (business location - search here first)\n`;
    }
    contextMessage += `LEAD RELEVANCE: Only generate leads that match the target market of the business.\n`;
  } else {
    contextMessage += `CRITICAL: ALWAYS prioritize business locations defined in the background/context.\n`;
    contextMessage += `First check if the business has specific locations, cities, or regions mentioned in the background.\n`;
    contextMessage += `Only expand to other cities if the business location is not specified or after covering the main business area.\n`;
  }
  
  contextMessage += `\nLOCATION TARGETING STRATEGY:\n`;
  if (business && business.location) {
    contextMessage += `1. PRIORITY: Focus on ${business.location} area (target business location)\n`;
    contextMessage += `2. SEARCH PATTERN: "[potential customer type] in ${business.location}"\n`;
    contextMessage += `3. LEAD QUALIFICATION: Ensure leads would be interested in the business's services\n`;
    contextMessage += `4. GEOGRAPHIC RELEVANCE: Stay within reasonable distance of the business location\n`;
  } else {
    contextMessage += `1. PRIORITY: Use business location from background/context if specified\n`;
    contextMessage += `2. SEARCH PATTERN: "[business type] owner [location]" OR "[business type] CEO [location]"\n`;
    contextMessage += `3. REPLACE [location] with the actual city/region from the business background\n`;
    contextMessage += `4. If no specific location in background, choose the most relevant location for the business\n`;
  }
  
  contextMessage += `\n${searchPrompts}\n`;
  
  contextMessage += `\nDATA SOURCES TO MAXIMIZE RESULTS:\n`;
  contextMessage += `• LinkedIn: Use advanced search with job title, company type, and location filters\n`;
  contextMessage += `• Google Business: Search for business directories and owner contact information\n`;
  contextMessage += `• Chamber of Commerce: Look for local business member directories\n`;
  contextMessage += `• Industry Associations: Find specialized industry member lists\n`;
  contextMessage += `• Local Business Awards: Search for recent business award winners\n`;
  contextMessage += `• Professional Directories: Look for profession-specific directories\n`;
  contextMessage += `• Company Websites: Look for "About Us", "Team", or "Contact" pages\n`;
  contextMessage += `• Social Media: Check company social profiles for team information\n`;
  
  contextMessage += `\nSEARCH OPTIMIZATION TECHNIQUES:\n`;
  contextMessage += `• Use boolean operators: "owner OR CEO OR director OR founder"\n`;
  contextMessage += `• Include bilingual terms when relevant (English/Spanish)\n`;
  contextMessage += `• Add contact intent: "+email OR +phone OR +contact"\n`;
  contextMessage += `• Use business size indicators: "small business OR SME OR startup"\n`;
  contextMessage += `• Include industry trends: "digital transformation", "sustainable", "innovative"\n`;
  contextMessage += `• Leverage current events: "post-pandemic", "remote work", "e-commerce growth"\n`;
  
  contextMessage += `\nCREATIVE SEARCH STRATEGIES:\n`;
  contextMessage += `• Cross-reference multiple data sources for verification\n`;
  contextMessage += `• Look for business growth indicators (hiring, expansion, funding)\n`;
  contextMessage += `• Search for industry-specific pain points or opportunities\n`;
  contextMessage += `• Find businesses mentioned in local news or industry publications\n`;
  contextMessage += `• Use company size and growth stage as search qualifiers\n`;
  contextMessage += `• Look for businesses with specific technology adoptions or certifications\n`;
  
  contextMessage += `\nBase search topic: ${searchTopic}\n`;
  contextMessage += `Requested leads: ${maxLeads}\n`;
  contextMessage += `Cities previously searched: ${usedCities.join(', ')}\n`;
  contextMessage += `Regions previously searched: ${Object.keys(usedRegions).length > 0 ? Object.entries(usedRegions).map(([city, regions]) => `${city}: [${regions.join(', ')}]`).join('; ') : 'None'}\n`;
  
  if (webhook) {
    contextMessage += `Webhook URL: ${webhook.url}\n`;
  }
  
  return contextMessage;
} 