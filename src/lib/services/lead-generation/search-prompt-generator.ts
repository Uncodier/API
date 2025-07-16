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

export interface CompanyData {
  name?: string;
  industry?: string;
  description?: string;
  location?: string;
  target_market?: string;
  services?: string | string[];
  size?: string;
  about?: string;
}

/**
 * Genera un topic de búsqueda personalizado basado en información específica de la empresa
 */
export function generatePersonalizedSearchTopic(
  company: CompanyData, 
  segments: SegmentData[], 
  convertedLeads: LeadData[]
): string {
  // Si no hay información de la empresa, usar la función original
  if (!company || (!company.name && !company.industry && !company.description)) {
    return generateSearchTopic(segments, convertedLeads);
  }

  let searchTopic = "";
  
  // Construir topic específico basado en la empresa
  if (company.name) {
    searchTopic = `employees, executives, and decision makers at ${company.name}`;
    
    // Añadir contexto de industria si está disponible
    if (company.industry) {
      searchTopic = `employees, executives, and decision makers at ${company.name} (${company.industry} company)`;
    }
    
    // Añadir contexto de tamaño si está disponible
    if (company.size) {
      const sizeContext = getSizeContext(company.size);
      if (sizeContext) {
        searchTopic = `employees, executives, and decision makers at ${company.name} (${sizeContext}${company.industry ? ` ${company.industry} company` : ' company'})`;
      }
    }
    
    // Añadir contexto de ubicación si está disponible
    if (company.location) {
      searchTopic += ` based in ${company.location}`;
    }
    
  } else if (company.industry) {
    // Si no hay nombre específico, usar industria
    searchTopic = `employees and executives from ${company.industry} companies`;
    
    if (company.size) {
      const sizeContext = getSizeContext(company.size);
      if (sizeContext) {
        searchTopic = `employees and executives from ${sizeContext} ${company.industry} companies`;
      }
    }
    
    if (company.location) {
      searchTopic += ` in ${company.location}`;
    }
  } else {
    // Fallback genérico pero más específico que antes
    searchTopic = "company employees, executives, and decision makers";
    
    if (company.location) {
      searchTopic += ` in ${company.location}`;
    }
  }

  return searchTopic;
}

/**
 * Convierte el tamaño de empresa en contexto descriptivo
 */
function getSizeContext(size: string): string | null {
  const sizeNormalized = size.toLowerCase();
  
  if (sizeNormalized.includes('startup') || sizeNormalized.includes('small')) {
    return 'small/startup';
  } else if (sizeNormalized.includes('medium') || sizeNormalized.includes('mid')) {
    return 'medium-sized';
  } else if (sizeNormalized.includes('large') || sizeNormalized.includes('enterprise')) {
    return 'large enterprise';
  } else if (sizeNormalized.includes('micro')) {
    return 'micro';
  }
  
  // Si contiene números, intentar interpretarlos
  const numberMatch = sizeNormalized.match(/(\d+)/);
  if (numberMatch) {
    const num = parseInt(numberMatch[1]);
    if (num < 10) return 'micro';
    if (num < 50) return 'small';
    if (num < 250) return 'medium-sized';
    if (num < 1000) return 'large';
    return 'enterprise';
  }
  
  return null;
}

/**
 * Genera un topic de búsqueda basado en los segmentos y leads convertidos (función original)
 */
export function generateSearchTopic(segments: SegmentData[], convertedLeads: LeadData[]): string {
  if (segments.length === 0) {
    return "company employees, executives, and decision makers contact information";
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
  let searchTopic = "company employees and executives contact information";
  
  if (uniquePositions.length > 0) {
    const hasExecutiveRoles = uniquePositions.some(pos => 
      pos.includes('ceo') || pos.includes('director') || pos.includes('founder') || pos.includes('owner')
    );
    const roleContext = hasExecutiveRoles ? 
      'executive and leadership team contact information' : 
      'management team and decision makers contact information';
    searchTopic = roleContext;
  }
  
  if (uniqueIndustries.length > 0) {
    searchTopic = `employees and executives from ${uniqueIndustries.join(', ')} industry companies`;
  }
  
  return searchTopic;
}

/**
 * Genera prompts de búsqueda personalizados basados en información específica de la empresa
 */
export function generatePersonalizedSearchPrompts(
  company: CompanyData, 
  segments: SegmentData[], 
  convertedLeads: LeadData[]
): string {
  let searchPrompts = `PERSONALIZED COMPANY EMPLOYEE RESEARCH STRATEGY:\n`;
  searchPrompts += `Focus on finding employees, executives, and decision makers WHO WORK AT the specific target company.\n\n`;

  // Información específica de la empresa
  if (company.name) {
    searchPrompts += `🎯 TARGET COMPANY: ${company.name}\n`;
    
    if (company.industry) {
      searchPrompts += `INDUSTRY SPECIALIZATION: ${company.industry}\n`;
      searchPrompts += `Search for employees with ${company.industry}-specific roles and expertise.\n`;
    }
    
    if (company.size) {
      const sizeContext = getSizeContext(company.size);
      if (sizeContext) {
        searchPrompts += `COMPANY SIZE: ${sizeContext}\n`;
        searchPrompts += `Target roles appropriate for ${sizeContext} organizations:\n`;
        
        if (sizeContext.includes('micro') || sizeContext.includes('small')) {
          searchPrompts += `- Focus on owners, founders, and multi-role executives\n`;
          searchPrompts += `- Look for hands-on decision makers with direct operational involvement\n`;
        } else if (sizeContext.includes('medium')) {
          searchPrompts += `- Target department heads, managers, and specialized directors\n`;
          searchPrompts += `- Look for both executives and key operational staff\n`;
        } else if (sizeContext.includes('large') || sizeContext.includes('enterprise')) {
          searchPrompts += `- Focus on C-level executives, VPs, and senior directors\n`;
          searchPrompts += `- Target specialized department heads and decision makers\n`;
        }
      }
    }
    
    if (company.location) {
      searchPrompts += `COMPANY LOCATION: ${company.location}\n`;
      searchPrompts += `Use local language and business terms for this region when searching.\n`;
    }
    
    if (company.services) {
      const services = Array.isArray(company.services) ? company.services : [company.services];
      searchPrompts += `COMPANY SERVICES: ${services.join(', ')}\n`;
      searchPrompts += `Look for employees involved in these service areas.\n`;
    }
    
    searchPrompts += `\n`;
  }

  // Estrategia de búsqueda específica
  searchPrompts += `🔍 PERSONALIZED SEARCH STRATEGY:\n`;
  if (company.name) {
    searchPrompts += `1. EXACT COMPANY SEARCH: "${company.name} CEO", "${company.name} founder", "${company.name} director"\n`;
    searchPrompts += `2. TEAM RESEARCH: "${company.name} team", "${company.name} leadership", "${company.name} staff"\n`;
    searchPrompts += `3. ORGANIZATIONAL STRUCTURE: "${company.name} management", "${company.name} executives"\n`;
    searchPrompts += `4. CONTACT VERIFICATION: "${company.name} contact", "${company.name} phone", "${company.name} email"\n`;
  }
  
  // Análisis de leads exitosos para personalización adicional
  if (convertedLeads.length > 0) {
    const successfulPositions = convertedLeads
      .map(lead => lead.position)
      .filter(pos => pos)
      .slice(0, 3);
    
    if (successfulPositions.length > 0) {
      searchPrompts += `\n📊 SUCCESSFUL POSITIONS TO TARGET:\n`;
      searchPrompts += `Based on previous conversions, prioritize these roles:\n`;
      successfulPositions.forEach(position => {
        searchPrompts += `- ${position} at ${company.name || 'target company'}\n`;
      });
    }
  }

  // Agregar prompts específicos de industria y región
  searchPrompts += `\n${generateIndustrySpecificPrompts(company)}`;

  return searchPrompts;
}

/**
 * Genera prompts específicos por industria y región de la empresa
 */
export function generateIndustrySpecificPrompts(company: CompanyData): string {
  let prompts = `INDUSTRY & REGION SPECIFIC SEARCH PROMPTS:\n\n`;
  
  // Prompts específicos por industria
  if (company.industry) {
    const industry = company.industry.toLowerCase();
    
    prompts += `🏭 INDUSTRY-SPECIFIC TARGETING (${company.industry}):\n`;
    
    if (industry.includes('technology') || industry.includes('tech') || industry.includes('software')) {
      prompts += `Tech Industry Roles:\n`;
      prompts += `- CTO, VP Engineering, Lead Developer at ${company.name || 'target company'}\n`;
      prompts += `- Product Manager, Technical Director at ${company.name || 'target company'}\n`;
      prompts += `- DevOps Engineer, System Administrator at ${company.name || 'target company'}\n`;
      prompts += `Search terms: "${company.name || 'company'} CTO", "${company.name || 'company'} tech lead", "${company.name || 'company'} developer"\n`;
    } else if (industry.includes('marketing') || industry.includes('advertising') || industry.includes('agency')) {
      prompts += `Marketing/Agency Roles:\n`;
      prompts += `- Creative Director, Account Manager at ${company.name || 'target company'}\n`;
      prompts += `- Digital Marketing Manager, Brand Manager at ${company.name || 'target company'}\n`;
      prompts += `- SEO Specialist, Content Manager at ${company.name || 'target company'}\n`;
      prompts += `Search terms: "${company.name || 'company'} creative director", "${company.name || 'company'} account manager"\n`;
    } else if (industry.includes('finance') || industry.includes('banking') || industry.includes('investment')) {
      prompts += `Finance Industry Roles:\n`;
      prompts += `- CFO, Financial Controller at ${company.name || 'target company'}\n`;
      prompts += `- Investment Manager, Risk Manager at ${company.name || 'target company'}\n`;
      prompts += `- Financial Analyst, Compliance Officer at ${company.name || 'target company'}\n`;
      prompts += `Search terms: "${company.name || 'company'} CFO", "${company.name || 'company'} financial director"\n`;
    } else if (industry.includes('healthcare') || industry.includes('medical') || industry.includes('pharmaceutical')) {
      prompts += `Healthcare Industry Roles:\n`;
      prompts += `- Medical Director, Chief Medical Officer at ${company.name || 'target company'}\n`;
      prompts += `- Healthcare Administrator, Clinical Director at ${company.name || 'target company'}\n`;
      prompts += `- Research Director, Regulatory Affairs Manager at ${company.name || 'target company'}\n`;
      prompts += `Search terms: "${company.name || 'company'} medical director", "${company.name || 'company'} healthcare admin"\n`;
    } else if (industry.includes('retail') || industry.includes('e-commerce') || industry.includes('commerce')) {
      prompts += `Retail/E-commerce Roles:\n`;
      prompts += `- Store Manager, Retail Operations Manager at ${company.name || 'target company'}\n`;
      prompts += `- E-commerce Manager, Digital Commerce Director at ${company.name || 'target company'}\n`;
      prompts += `- Merchandising Manager, Supply Chain Manager at ${company.name || 'target company'}\n`;
      prompts += `Search terms: "${company.name || 'company'} store manager", "${company.name || 'company'} e-commerce director"\n`;
    } else if (industry.includes('education') || industry.includes('training') || industry.includes('academic')) {
      prompts += `Education Industry Roles:\n`;
      prompts += `- Academic Director, Dean at ${company.name || 'target company'}\n`;
      prompts += `- Training Manager, Educational Coordinator at ${company.name || 'target company'}\n`;
      prompts += `- Curriculum Developer, Program Director at ${company.name || 'target company'}\n`;
      prompts += `Search terms: "${company.name || 'company'} director", "${company.name || 'company'} coordinator"\n`;
    } else if (industry.includes('manufacturing') || industry.includes('industrial') || industry.includes('production')) {
      prompts += `Manufacturing Industry Roles:\n`;
      prompts += `- Operations Manager, Production Manager at ${company.name || 'target company'}\n`;
      prompts += `- Quality Control Manager, Plant Manager at ${company.name || 'target company'}\n`;
      prompts += `- Supply Chain Director, Manufacturing Engineer at ${company.name || 'target company'}\n`;
      prompts += `Search terms: "${company.name || 'company'} operations manager", "${company.name || 'company'} plant manager"\n`;
    } else {
      // Generic industry approach
      prompts += `General Industry Roles:\n`;
      prompts += `- Operations Manager, Department Head at ${company.name || 'target company'}\n`;
      prompts += `- Business Development Manager, Strategy Director at ${company.name || 'target company'}\n`;
      prompts += `- Project Manager, Team Lead at ${company.name || 'target company'}\n`;
      prompts += `Search terms: "${company.name || 'company'} manager", "${company.name || 'company'} director"\n`;
    }
    
    prompts += `\n`;
  }
  
  // Prompts específicos por región/ubicación
  if (company.location) {
    prompts += `🌍 LOCATION-SPECIFIC SEARCH STRATEGY (${company.location}):\n`;
    
    const location = company.location.toLowerCase();
    
    if (location.includes('spain') || location.includes('españa') || location.includes('madrid') || location.includes('barcelona')) {
      prompts += `Spanish Market Terms:\n`;
      prompts += `- "${company.name || 'empresa'} director ejecutivo", "${company.name || 'empresa'} gerente general"\n`;
      prompts += `- "equipo directivo de ${company.name || 'empresa'}", "responsable de ${company.name || 'empresa'}"\n`;
      prompts += `- "contacto ${company.name || 'empresa'}", "teléfono ${company.name || 'empresa'} España"\n`;
      prompts += `Business Culture: Focus on formal titles and hierarchical structures\n`;
    } else if (location.includes('mexico') || location.includes('méxico') || location.includes('guadalajara') || location.includes('monterrey')) {
      prompts += `Mexican Market Terms:\n`;
      prompts += `- "${company.name || 'empresa'} dueño", "${company.name || 'empresa'} propietario"\n`;
      prompts += `- "gerente general de ${company.name || 'empresa'}", "director de ${company.name || 'empresa'}"\n`;
      prompts += `- "contacto ${company.name || 'empresa'} México", "oficina ${company.name || 'empresa'}"\n`;
      prompts += `Business Culture: Emphasize relationship-building and family business structures\n`;
    } else if (location.includes('brazil') || location.includes('brasil') || location.includes('são paulo') || location.includes('rio')) {
      prompts += `Brazilian Market Terms:\n`;
      prompts += `- "${company.name || 'empresa'} proprietário", "${company.name || 'empresa'} sócio"\n`;
      prompts += `- "diretor geral da ${company.name || 'empresa'}", "gerente da ${company.name || 'empresa'}"\n`;
      prompts += `- "contato ${company.name || 'empresa'} Brasil", "escritório ${company.name || 'empresa'}"\n`;
      prompts += `Business Culture: Focus on personal connections and networking\n`;
    } else if (location.includes('colombia') || location.includes('bogotá') || location.includes('medellín')) {
      prompts += `Colombian Market Terms:\n`;
      prompts += `- "${company.name || 'empresa'} gerente general", "${company.name || 'empresa'} director"\n`;
      prompts += `- "equipo de ${company.name || 'empresa'}", "empleados de ${company.name || 'empresa'}"\n`;
      prompts += `- "contacto ${company.name || 'empresa'} Colombia", "oficina ${company.name || 'empresa'}"\n`;
      prompts += `Business Culture: Professional but warm approach to business relationships\n`;
    } else if (location.includes('argentina') || location.includes('buenos aires') || location.includes('córdoba')) {
      prompts += `Argentine Market Terms:\n`;
      prompts += `- "${company.name || 'empresa'} director", "${company.name || 'empresa'} responsable"\n`;
      prompts += `- "equipo directivo de ${company.name || 'empresa'}", "gerencia de ${company.name || 'empresa'}"\n`;
      prompts += `- "contacto ${company.name || 'empresa'} Argentina", "sede ${company.name || 'empresa'}"\n`;
      prompts += `Business Culture: European-influenced business formality with Latin warmth\n`;
    } else if (location.includes('chile') || location.includes('santiago') || location.includes('valparaíso')) {
      prompts += `Chilean Market Terms:\n`;
      prompts += `- "${company.name || 'empresa'} gerente general", "${company.name || 'empresa'} ejecutivo"\n`;
      prompts += `- "administración de ${company.name || 'empresa'}", "dirección de ${company.name || 'empresa'}"\n`;
      prompts += `- "contacto ${company.name || 'empresa'} Chile", "sucursal ${company.name || 'empresa'}"\n`;
      prompts += `Business Culture: Conservative and formal business environment\n`;
    } else if (location.includes('united states') || location.includes('usa') || location.includes('california') || location.includes('new york')) {
      prompts += `US Market Terms:\n`;
      prompts += `- "${company.name || 'company'} CEO", "${company.name || 'company'} President"\n`;
      prompts += `- "${company.name || 'company'} executive team", "${company.name || 'company'} leadership"\n`;
      prompts += `- "${company.name || 'company'} contact", "${company.name || 'company'} headquarters"\n`;
      prompts += `Business Culture: Direct communication and results-oriented approach\n`;
    } else {
      prompts += `General International Terms:\n`;
      prompts += `- "${company.name || 'company'} management", "${company.name || 'company'} executives"\n`;
      prompts += `- "${company.name || 'company'} team", "${company.name || 'company'} staff"\n`;
      prompts += `- "${company.name || 'company'} contact information", "${company.name || 'company'} office"\n`;
    }
    
    prompts += `\n`;
  }
  
  // Combinación de industria y ubicación
  if (company.industry && company.location) {
    prompts += `🎯 COMBINED INDUSTRY + LOCATION TARGETING:\n`;
    prompts += `Search for ${company.industry} professionals specifically at ${company.name || 'target company'} in ${company.location}\n`;
    prompts += `Focus on local business networks and industry associations in ${company.location}\n`;
    prompts += `Look for company representation at ${company.industry} events in ${company.location}\n`;
    prompts += `\n`;
  }
  
  return prompts;
}

/**
 * Genera prompts dinámicos de búsqueda basados en patrones de leads exitosos (función original)
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
  
  let searchPrompts = `COMPANY EMPLOYEE RESEARCH SEARCH TERMS:\n`;
  searchPrompts += `Focus on creating specific search terms to find employees, executives, and decision makers WHO WORK AT the target company.\n\n`;
  
  searchPrompts += `🌍 CRITICAL: USE LOCAL LANGUAGE FOR COMPANY EMPLOYEE RESEARCH\n`;
  searchPrompts += `MANDATORY: All search terms must be in the native language of the company's region.\n`;
  searchPrompts += `This maximizes results when searching for company employees and executives.\n\n`;
  
  searchPrompts += `🎯 COMPANY EMPLOYEE SEARCH STRATEGY:\n`;
  searchPrompts += `Generate search terms that combine:\n`;
  searchPrompts += `- EXACT COMPANY NAME + employee/executive titles IN LOCAL LANGUAGE\n`;
  searchPrompts += `- EXACT COMPANY NAME + organizational terms IN LOCAL LANGUAGE\n`;
  searchPrompts += `- EXACT COMPANY NAME + contact information terms IN LOCAL LANGUAGE\n`;
  searchPrompts += `\nExample approach for finding company employees:\n`;
  searchPrompts += `  • For Spanish company "Genicrea": "Genicrea CEO", "equipo de Genicrea", "empleados de Genicrea"\n`;
  searchPrompts += `  • For Mexican company "TechMX": "TechMX dueño", "empleados de TechMX", "equipo directivo TechMX"\n`;
  searchPrompts += `  • For US company "TechCorp": "TechCorp founder", "TechCorp leadership team", "TechCorp employees"\n\n`;
  
  if (uniquePositions.length > 0) {
    searchPrompts += `EXECUTIVE POSITIONS TO TARGET: ${uniquePositions.join(', ')}\n`;
    searchPrompts += `Search for these positions AT THE TARGET COMPANY using LOCAL LANGUAGE terms:\n`;
    searchPrompts += `- Spanish regions: "[company name] CEO", "[company name] fundador", "[company name] director general"\n`;
    searchPrompts += `- English regions: "[company name] CEO", "[company name] founder", "[company name] director"\n`;
    searchPrompts += `- Portuguese regions: "[company name] CEO", "[company name] fundador", "[company name] diretor"\n`;
    searchPrompts += `- French regions: "[company name] PDG", "[company name] fondateur", "[company name] directeur"\n\n`;
  }
  
  if (uniqueIndustries.length > 0) {
    searchPrompts += `INDUSTRY CONTEXT: ${uniqueIndustries.join(', ')}\n`;
    searchPrompts += `Use industry knowledge to find relevant employees at the target company:\n`;
    searchPrompts += `- Look for industry-specific roles (CTO for tech companies, Creative Director for agencies)\n`;
    searchPrompts += `- Search for department heads relevant to the industry\n`;
    searchPrompts += `- Find employees with industry-specific certifications or expertise\n\n`;
  }
  
  searchPrompts += `COMPANY EMPLOYEE SEARCH EXAMPLES:\n`;
  searchPrompts += `For "Genicrea | Agencia Digital" (Spanish digital agency):\n`;
  searchPrompts += `✅ "Genicrea CEO" → Find the CEO of Genicrea\n`;
  searchPrompts += `✅ "equipo de Genicrea" → Find team members at Genicrea\n`;
  searchPrompts += `✅ "empleados de Genicrea" → Find employees at Genicrea\n`;
  searchPrompts += `✅ "director creativo Genicrea" → Find creative director at Genicrea\n`;
  searchPrompts += `✅ "contacto Genicrea" → Find contact information for Genicrea\n`;
  searchPrompts += `❌ "clientes de Genicrea" → DON'T find clients of Genicrea\n`;
  searchPrompts += `❌ "agencias como Genicrea" → DON'T find similar agencies\n\n`;
  
  searchPrompts += `CRITICAL COMPANY EMPLOYEE RESEARCH RULES:\n`;
  searchPrompts += `1. Use the EXACT company name + local language terms for employee research\n`;
  searchPrompts += `2. Focus on finding people WHO WORK AT the specific company, not clients or competitors\n`; 
  searchPrompts += `3. Search for company organizational structure, team pages, and employee directories\n`;
  searchPrompts += `4. Target executives, decision makers, and key personnel AT the company\n`;
  searchPrompts += `5. Use local language terms for maximum search effectiveness in the company's region\n`;
  searchPrompts += `6. Verify employment status - ensure leads actually work at the target company\n`;
  searchPrompts += `7. NEVER search for clients, customers, or competitors of the company\n`;

  return searchPrompts;
}

/**
 * Genera un mensaje de contexto personalizado basado en información específica de la empresa
 */
export function generatePersonalizedContextMessage(
  company: CompanyData,
  segments: SegmentData[], 
  convertedLeads: LeadData[], 
  nonConvertedLeads: LeadData[],
  searchTopic: string,
  searchPrompts: string,
  usedCities: string[],
  usedRegions: { [key: string]: string[] },
  maxLeads: number,
  webhook?: { url: string }
): string {
  let contextMessage = `PERSONALIZED LEAD GENERATION ANALYSIS\n\n`;
  
  // Información específica de la empresa objetivo
  contextMessage += `🎯 TARGET COMPANY PROFILE:\n`;
  
  if (company.name) {
    contextMessage += `Company Name: ${company.name}\n`;
    contextMessage += `CRITICAL FOCUS: Find employees, executives, and decision makers WHO WORK AT "${company.name}"\n`;
  }
  
  if (company.industry) {
    contextMessage += `Industry: ${company.industry}\n`;
    contextMessage += `Target roles specific to ${company.industry} sector\n`;
  }
  
  if (company.size) {
    contextMessage += `Company Size: ${company.size}\n`;
    const sizeContext = getSizeContext(company.size);
    if (sizeContext) {
      contextMessage += `Focus on roles appropriate for ${sizeContext} organizations\n`;
    }
  }
  
  if (company.location) {
    contextMessage += `Location: ${company.location}\n`;
    contextMessage += `Use local language and business culture for this region\n`;
  }
  
  if (company.description || company.about) {
    const description = company.description || company.about;
    contextMessage += `Description: ${description}\n`;
  }
  
  if (company.services) {
    const services = Array.isArray(company.services) ? company.services.join(', ') : company.services;
    contextMessage += `Services: ${services}\n`;
  }
  
  if (company.target_market) {
    contextMessage += `Target Market: ${company.target_market}\n`;
  }
  
  contextMessage += `\n`;
  
  // Estrategia específica de la empresa
  contextMessage += `🎯 COMPANY-SPECIFIC SEARCH STRATEGY:\n`;
  if (company.name) {
    contextMessage += `PRIMARY OBJECTIVE: Find people who work at "${company.name}" specifically\n`;
    contextMessage += `SEARCH PATTERNS:\n`;
    contextMessage += `- Direct company search: "${company.name} CEO", "${company.name} founder"\n`;
    contextMessage += `- Team discovery: "${company.name} team", "${company.name} leadership"\n`;
    contextMessage += `- Organizational research: "${company.name} employees", "${company.name} staff"\n`;
    contextMessage += `- Contact verification: "${company.name} contact information"\n`;
    
    if (company.industry) {
      contextMessage += `INDUSTRY-SPECIFIC ROLES:\n`;
      contextMessage += `Target ${company.industry}-specific positions at "${company.name}"\n`;
      contextMessage += `Look for expertise relevant to ${company.industry} sector\n`;
    }
    
    contextMessage += `\n`;
  }
  
  // Información de segmentos (simplificada y enfocada)
  if (segments.length > 0) {
    contextMessage += `ACTIVE SEGMENTS FOR REFERENCE (${segments.length}):\n`;
    segments.slice(0, 3).forEach((segment, index) => {
      contextMessage += `${index + 1}. ${segment.name}`;
      if (segment.description) contextMessage += ` - ${segment.description}`;
      contextMessage += `\n`;
    });
    contextMessage += `\n`;
  }
  
  // Análisis de leads convertidos (enfocado en patrones útiles)
  if (convertedLeads.length > 0) {
    contextMessage += `SUCCESSFUL CONVERSION PATTERNS (${convertedLeads.length} leads):\n`;
    
    // Analizar posiciones exitosas
    const successfulPositions = convertedLeads
      .map(lead => lead.position)
      .filter((pos): pos is string => !!pos)
      .reduce((acc: {[key: string]: number}, pos) => {
        acc[pos] = (acc[pos] || 0) + 1;
        return acc;
      }, {});
    
    if (Object.keys(successfulPositions).length > 0) {
      contextMessage += `Top converting positions:\n`;
      Object.entries(successfulPositions)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3)
        .forEach(([position, count]) => {
          contextMessage += `- ${position} (${count} conversions)\n`;
        });
    }
    
    // Analizar industrias exitosas
    const successfulIndustries = convertedLeads
      .map(lead => lead.company?.industry)
      .filter((industry): industry is string => !!industry)
      .reduce((acc: {[key: string]: number}, industry) => {
        acc[industry] = (acc[industry] || 0) + 1;
        return acc;
      }, {});
    
    if (Object.keys(successfulIndustries).length > 0) {
      contextMessage += `Top converting industries:\n`;
      Object.entries(successfulIndustries)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3)
        .forEach(([industry, count]) => {
          contextMessage += `- ${industry} (${count} conversions)\n`;
        });
    }
    
    contextMessage += `\n`;
  }
  
  // Configuración de búsqueda específica
  contextMessage += `SEARCH CONFIGURATION:\n`;
  contextMessage += `Target: ${company.name || 'Specific company'} employees and executives\n`;
  contextMessage += `Search Topic: ${searchTopic}\n`;
  contextMessage += `Leads Requested: ${maxLeads}\n`;
  
  if (company.location) {
    contextMessage += `Geographic Focus: ${company.location}\n`;
  }
  
  if (usedCities.length > 0) {
    contextMessage += `Previously Searched Cities: ${usedCities.join(', ')}\n`;
  }
  
  contextMessage += `\n`;
  
  // Prompts de búsqueda personalizados
  contextMessage += `${searchPrompts}\n`;
  
  // Fuentes de datos específicas para la empresa
  contextMessage += `RECOMMENDED DATA SOURCES FOR COMPANY RESEARCH:\n`;
  if (company.name) {
    contextMessage += `• Company Website: Look for "About Us", "Team", "Leadership" pages\n`;
    contextMessage += `• LinkedIn Company Page: Search for current employees at "${company.name}"\n`;
    contextMessage += `• Business Directories: Find "${company.name}" in industry-specific directories\n`;
    contextMessage += `• Industry Publications: Search for "${company.name}" executives in trade publications\n`;
    contextMessage += `• Professional Networks: Find "${company.name}" employees in professional associations\n`;
    contextMessage += `• News and Media: Search for "${company.name}" representatives in news articles\n`;
  }
  
  if (webhook) {
    contextMessage += `\nWebhook URL: ${webhook.url}\n`;
  }
  
  return contextMessage;
}

/**
 * Genera el mensaje de contexto completo para el agente (función original)
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
  company?: any // Cambio de business a company
): string {
  let contextMessage = `LEAD SEGMENT ANALYSIS\n\n`;
  
  // Información de la empresa objetivo (si se proporciona)
  if (company) {
    contextMessage += `TARGET COMPANY INTERNAL RESEARCH:\n`;
    contextMessage += `This lead generation is focused on finding specific business owners, key decision makers, and executives WHO WORK AT the specific company provided:\n`;
    
    if (company.name) {
      contextMessage += `Company Name: ${company.name}\n`;
    }
    
    if (company.industry) {
      contextMessage += `Industry: ${company.industry}\n`;
    }
    
    if (company.description) {
      contextMessage += `Description: ${company.description}\n`;
    }
    
    if (company.location) {
      contextMessage += `Location: ${company.location}\n`;
    }
    
    if (company.target_market) {
      contextMessage += `Target Market: ${company.target_market}\n`;
    }
    
    if (company.services) {
      contextMessage += `Services: ${Array.isArray(company.services) ? company.services.join(', ') : company.services}\n`;
    }
    
    if (company.size) {
      contextMessage += `Company Size: ${company.size}\n`;
    }
    
    contextMessage += `\n🎯 CRITICAL FOCUS: Find business owners, CEOs, founders, directors, managers, and key decision makers who WORK AT "${company.name || 'the specified company'}":\n`;
    contextMessage += `- CEO, founder, or owner of ${company.name || 'the company'}\n`;
    contextMessage += `- Directors and department heads at ${company.name || 'the company'}\n`;
    contextMessage += `- Senior managers and executives at ${company.name || 'the company'}\n`;
    contextMessage += `- Key decision makers employed by ${company.name || 'the company'}\n`;
    contextMessage += `- Partners or co-founders of ${company.name || 'the company'}\n\n`;
    
    contextMessage += `🔍 DEEP RESEARCH STRATEGY: Find specific people who work at "${company.name || 'the specified company'}" with these approaches:\n`;
    contextMessage += `1. Search for the company name + decision maker titles\n`;
    contextMessage += `2. Look for company leadership team information\n`;
    contextMessage += `3. Find employee directories and organizational charts\n`;
    contextMessage += `4. Search for company executives in business publications\n`;
    contextMessage += `5. Look for company representatives at events or interviews\n`;
    contextMessage += `6. Find team pages on company website and social media\n`;
    contextMessage += `7. Search for company leadership in industry directories\n`;
    contextMessage += `8. Look for company founders and key personnel in startup databases\n\n`;
    
    contextMessage += `📍 SPECIFIC COMPANY RESEARCH: Focus on finding contact information for people who work at "${company.name || 'the specified company'}"\n`;
    contextMessage += `- Search for "${company.name || 'company name'} CEO" or "${company.name || 'company name'} founder"\n`;
    contextMessage += `- Look for "${company.name || 'company name'} director" or "${company.name || 'company name'} manager"\n`;
    contextMessage += `- Find "${company.name || 'company name'} team" or "${company.name || 'company name'} leadership"\n`;
    contextMessage += `- Search for "${company.name || 'company name'} owner" or "${company.name || 'company name'} executive"\n`;
    contextMessage += `- Look for company organizational structure and employee information\n\n`;
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
  if (company) {
    contextMessage += `TARGET COMPANY INTERNAL RESEARCH: Find decision makers and executives WHO WORK AT the specific company mentioned above.\n`;
    contextMessage += `CRITICAL: Focus on finding people who are employed by, own, or have leadership roles AT "${company.name || 'the specified company'}":\n`;
    contextMessage += `- CEO, founder, or owner of the company\n`;
    contextMessage += `- Directors, managers, and department heads\n`;
    contextMessage += `- Senior executives and key decision makers\n`;
    contextMessage += `- Partners, co-founders, or stakeholders\n`;
    if (company.location) {
      contextMessage += `COMPANY LOCATION: ${company.location} (search for company employees/executives in this location)\n`;
    }
    contextMessage += `LEAD RELEVANCE: Only find people who actually work at or own "${company.name || 'the specified company'}" - not clients or customers.\n`;
  } else {
    contextMessage += `CRITICAL: ALWAYS prioritize company locations defined in the background/context.\n`;
    contextMessage += `First check if the company has specific locations, cities, or regions mentioned in the background.\n`;
    contextMessage += `Focus on finding employees and executives of the specific company mentioned.\n`;
  }
  
  contextMessage += `\nCOMPANY INTERNAL RESEARCH STRATEGY:\n`;
  if (company && company.name) {
    contextMessage += `1. PRIORITY: Find executives and decision makers who work AT "${company.name}"\n`;
    contextMessage += `2. SEARCH PATTERN: "${company.name} CEO", "${company.name} founder", "${company.name} director"\n`;
    contextMessage += `3. EMPLOYEE RESEARCH: Find organizational charts, team pages, and employee directories\n`;
    contextMessage += `4. LEADERSHIP FOCUS: Target C-level executives, founders, owners, and department heads\n`;
    contextMessage += `5. COMPANY VERIFICATION: Ensure leads are actually affiliated with "${company.name}"\n`;
  } else {
    contextMessage += `1. PRIORITY: Use company name from background/context for targeted employee search\n`;
    contextMessage += `2. SEARCH PATTERN: "[company name] CEO", "[company name] founder", "[company name] director"\n`;
    contextMessage += `3. EMPLOYEE RESEARCH: Find people who work at the specific company mentioned\n`;
    contextMessage += `4. LEADERSHIP FOCUS: Target executives, owners, and decision makers of the company\n`;
    contextMessage += `5. COMPANY VERIFICATION: Ensure leads are actually employees or owners of the target company\n`;
  }
  
  contextMessage += `\n${searchPrompts}\n`;
  
  contextMessage += `\nDATA SOURCES TO FIND COMPANY EMPLOYEES/EXECUTIVES:\n`;
  contextMessage += `• LinkedIn: Search for people who work at "${company?.name || 'the company'}" with titles like CEO, founder, director, manager\n`;
  contextMessage += `• Company Website: Look for "About Us", "Team", "Leadership", "Our Team" pages for executive information\n`;
  contextMessage += `• Company Social Media: Check LinkedIn company page, Facebook, Twitter for team member mentions\n`;
  contextMessage += `• Business Directories: Search for company listings that include owner/executive information\n`;
  contextMessage += `• Industry Publications: Look for articles featuring company executives or founder interviews\n`;
  contextMessage += `• Professional Networks: Search for company employees in professional directories\n`;
  contextMessage += `• Startup Databases: If applicable, look for founder information in startup directories\n`;
  contextMessage += `• Business Registration: Check business registration records for owner/officer information\n`;
  contextMessage += `• News Articles: Search for company news that mentions executives or key personnel\n`;
  contextMessage += `• Industry Events: Look for company representatives at conferences, events, or speaking engagements\n`;
  contextMessage += `• Employee Directories: Search for internal phone books or organizational charts if available\n`;
  contextMessage += `• Professional Associations: Find company executives in industry association member lists\n`;
  
  contextMessage += `\nSEARCH OPTIMIZATION FOR COMPANY EMPLOYEE RESEARCH:\n`;
  contextMessage += `• Use company name + executive titles: "${company?.name || 'company name'} CEO", "${company?.name || 'company name'} founder"\n`;
  contextMessage += `• Search for organizational hierarchy: "${company?.name || 'company name'} leadership team", "${company?.name || 'company name'} management"\n`;
  contextMessage += `• Look for employee mentions: "${company?.name || 'company name'} staff", "${company?.name || 'company name'} employees"\n`;
  contextMessage += `• Find department heads: "${company?.name || 'company name'} director", "${company?.name || 'company name'} manager"\n`;
  contextMessage += `• Search for company ownership: "${company?.name || 'company name'} owner", "${company?.name || 'company name'} proprietor"\n`;
  contextMessage += `• Look for key personnel: "${company?.name || 'company name'} team", "${company?.name || 'company name'} key personnel"\n`;
  contextMessage += `• Include contact verification: "${company?.name || 'company name'} contact", "${company?.name || 'company name'} phone", "${company?.name || 'company name'} email"\n`;
  
  contextMessage += `\nCREATIVE COMPANY EMPLOYEE RESEARCH STRATEGIES:\n`;
  contextMessage += `• Cross-reference multiple sources to verify current employment at "${company?.name || 'the company'}"\n`;
  contextMessage += `• Look for company announcements about new hires, promotions, or team changes\n`;
  contextMessage += `• Search for company employee mentions in industry publications and news articles\n`;
  contextMessage += `• Find executives who represent "${company?.name || 'the company'}" at events, conferences, or interviews\n`;
  contextMessage += `• Look for company team photos, employee spotlights, or "meet the team" features\n`;
  contextMessage += `• Search for company founders and key personnel in startup and business databases\n`;
  contextMessage += `• Find employees who are active in professional communities while representing the company\n`;
  contextMessage += `• Look for company personnel in business award lists, recognition programs, or industry honors\n`;
  contextMessage += `• Search for company employee LinkedIn profiles and professional network connections\n`;
  contextMessage += `• Find company representatives in industry association member directories\n`;
  contextMessage += `• Look for company employees in professional certification or training program lists\n`;
  contextMessage += `• Search for company team members in business publication interviews or expert quotes\n`;
  
  contextMessage += `\n🌍 CRITICAL SEO OPTIMIZATION - LOCAL LANGUAGE FOR COMPANY RESEARCH:\n`;
  contextMessage += `MANDATORY: Use search terms in the LOCAL LANGUAGE of the company's region to find employees and executives.\n`;
  contextMessage += `\nLANGUAGE GUIDELINES FOR COMPANY EMPLOYEE RESEARCH:\n`;
  contextMessage += `• SPAIN/SPANISH REGIONS: Use Spanish terms to find company employees\n`;
  contextMessage += `  - "${company?.name || 'nombre de empresa'} CEO", "${company?.name || 'nombre de empresa'} fundador", "${company?.name || 'nombre de empresa'} director"\n`;
  contextMessage += `  - "${company?.name || 'nombre de empresa'} propietario", "${company?.name || 'nombre de empresa'} gerente", "${company?.name || 'nombre de empresa'} equipo"\n`;
  contextMessage += `  - "equipo de ${company?.name || 'empresa'}", "liderazgo de ${company?.name || 'empresa'}", "empleados de ${company?.name || 'empresa'}"\n`;
  contextMessage += `  - "contacto ${company?.name || 'empresa'}", "teléfono ${company?.name || 'empresa'}", "información ${company?.name || 'empresa'}"\n`;
  contextMessage += `\n• MEXICO/LATIN AMERICA: Use Mexican Spanish terms for company research\n`;
  contextMessage += `  - "${company?.name || 'nombre de empresa'} dueño", "${company?.name || 'nombre de empresa'} empresario", "${company?.name || 'nombre de empresa'} director ejecutivo"\n`;
  contextMessage += `  - "${company?.name || 'nombre de empresa'} gerente general", "${company?.name || 'nombre de empresa'} staff", "${company?.name || 'nombre de empresa'} equipo directivo"\n`;
  contextMessage += `  - "empleados de ${company?.name || 'empresa'}", "personal de ${company?.name || 'empresa'}", "directivos de ${company?.name || 'empresa'}"\n`;
  contextMessage += `  - "contacto ${company?.name || 'empresa'}", "teléfono ${company?.name || 'empresa'}", "correo ${company?.name || 'empresa'}"\n`;
  contextMessage += `\n• UNITED STATES/ENGLISH REGIONS: Use English terms for company research\n`;
  contextMessage += `  - "${company?.name || 'company name'} CEO", "${company?.name || 'company name'} founder", "${company?.name || 'company name'} director"\n`;
  contextMessage += `  - "${company?.name || 'company name'} owner", "${company?.name || 'company name'} executive", "${company?.name || 'company name'} management team"\n`;
  contextMessage += `  - "${company?.name || 'company name'} employees", "${company?.name || 'company name'} staff", "${company?.name || 'company name'} leadership"\n`;
  contextMessage += `  - "${company?.name || 'company name'} contact", "${company?.name || 'company name'} phone", "${company?.name || 'company name'} email"\n`;
  contextMessage += `\n• BRAZIL: Use Portuguese terms for company research\n`;
  contextMessage += `  - "${company?.name || 'nome da empresa'} CEO", "${company?.name || 'nome da empresa'} fundador", "${company?.name || 'nome da empresa'} diretor"\n`;
  contextMessage += `  - "${company?.name || 'nome da empresa'} proprietário", "${company?.name || 'nome da empresa'} gerente", "${company?.name || 'nome da empresa'} equipe"\n`;
  contextMessage += `  - "funcionários da ${company?.name || 'empresa'}", "liderança da ${company?.name || 'empresa'}", "equipe da ${company?.name || 'empresa'}"\n`;
  contextMessage += `  - "contato ${company?.name || 'empresa'}", "telefone ${company?.name || 'empresa'}", "email ${company?.name || 'empresa'}"\n`;
  contextMessage += `\n• FRANCE: Use French terms for company research\n`;
  contextMessage += `  - "${company?.name || 'nom de l\'entreprise'} PDG", "${company?.name || 'nom de l\'entreprise'} fondateur", "${company?.name || 'nom de l\'entreprise'} directeur"\n`;
  contextMessage += `  - "${company?.name || 'nom de l\'entreprise'} propriétaire", "${company?.name || 'nom de l\'entreprise'} gérant", "${company?.name || 'nom de l\'entreprise'} équipe"\n`;
  contextMessage += `  - "employés de ${company?.name || 'entreprise'}", "direction de ${company?.name || 'entreprise'}", "personnel de ${company?.name || 'entreprise'}"\n`;
  contextMessage += `  - "contact ${company?.name || 'entreprise'}", "téléphone ${company?.name || 'entreprise'}", "email ${company?.name || 'entreprise'}"\n`;
  contextMessage += `\n🔍 COMPANY EMPLOYEE SEARCH LOCALIZATION:\n`;
  contextMessage += `1. IDENTIFY COMPANY REGION: Determine the location/country of the target company\n`;
  contextMessage += `2. USE LOCAL LANGUAGE: All search terms for finding company employees must be in the native language\n`;
  contextMessage += `3. COMPANY-SPECIFIC TERMS: Include the exact company name + local language employee/executive terms\n`;
  contextMessage += `4. CULTURAL CONTEXT: Use business titles and organizational terms common in that business culture\n`;
  contextMessage += `5. LOCAL BUSINESS CONTEXT: Search using terms locals would use to find company information\n`;
  contextMessage += `6. REGIONAL VARIATIONS: Account for regional differences in company terminology\n`;
  contextMessage += `\n🎯 COMPANY RESEARCH EXAMPLES:\n`;
  contextMessage += `• For Spanish company: "${company?.name || 'Empresa'} CEO" AND "equipo directivo de ${company?.name || 'Empresa'}"\n`;
  contextMessage += `• For Mexican company: "${company?.name || 'Empresa'} dueño" AND "empleados de ${company?.name || 'Empresa'}"\n`;
  contextMessage += `• For US company: "${company?.name || 'Company'} founder" AND "${company?.name || 'Company'} leadership team"\n`;
  contextMessage += `• For Brazilian company: "${company?.name || 'Empresa'} proprietário" AND "funcionários da ${company?.name || 'Empresa'}"\n`;
  contextMessage += `• For French company: "${company?.name || 'Entreprise'} PDG" AND "employés de ${company?.name || 'Entreprise'}"\n`;
  contextMessage += `\n⚠️ CRITICAL RULE: Use the company's exact name + local language terms for employee/executive research.\n`;
  contextMessage += `Example: For "Genicrea | Agencia Digital" in Spain → "Genicrea CEO" AND "equipo de Genicrea" AND "empleados de Genicrea"\n`;

  contextMessage += `\nBase search topic: ${searchTopic}\n`;
  contextMessage += `Requested leads: ${maxLeads}\n`;
  contextMessage += `Target company: ${company?.name || 'Not specified'}\n`;
  if (company?.location) {
    contextMessage += `Company location: ${company.location}\n`;
  }
  contextMessage += `Cities previously searched: ${usedCities.join(', ')}\n`;
  contextMessage += `Regions previously searched: ${Object.keys(usedRegions).length > 0 ? Object.entries(usedRegions).map(([city, regions]) => `${city}: [${regions.join(', ')}]`).join('; ') : 'None'}\n`;
  
  if (webhook) {
    contextMessage += `Webhook URL: ${webhook.url}\n`;
  }
  
  return contextMessage;
} 