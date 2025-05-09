/**
 * CapabilitiesExtractor.ts
 * Clase especializada para extraer capabilities de diferentes tipos de herramientas
 */

export class CapabilitiesExtractor {
  /**
   * Extrae capabilities de un conjunto de herramientas (array u objeto)
   * @param tools Array u objeto de herramientas 
   * @param sourceDescription Descripción de la fuente para logs
   * @returns Array de capabilities extraídas
   */
  public static extractCapabilitiesFromTools(tools: any[] | Record<string, any>, sourceDescription: string): string[] {
    console.log(`🧠 [CapabilitiesExtractor] Extrayendo capabilities de tools para ${sourceDescription}`);
    
    // Si no hay tools, retornar array vacío
    if (!tools) {
      console.log(`ℹ️ [CapabilitiesExtractor] No hay tools para extraer capabilities de ${sourceDescription}`);
      return [];
    }

    // Si es un array de tools
    if (Array.isArray(tools)) {
      return this.extractFromArray(tools, sourceDescription);
    }
    
    // Si es un objeto de tools
    if (typeof tools === 'object') {
      return this.extractFromObject(tools, sourceDescription);
    }
    
    // Si no es ni array ni objeto, retornar array vacío
    console.log(`⚠️ [CapabilitiesExtractor] Formato de tools no reconocido para ${sourceDescription}`);
    return [];
  }

  /**
   * Extrae capabilities de un array de herramientas
   */
  private static extractFromArray(tools: any[], sourceDescription: string): string[] {
    console.log(`🧠 [CapabilitiesExtractor] Procesando array de ${tools.length} tools para ${sourceDescription}`);
    
    const capabilities = tools.map((tool: any) => {
      // Si es un string directo, usarlo como capability
      if (typeof tool === 'string') {
        return tool;
      }
      
      // Si es un objeto con función anidada (formato OpenAI)
      if (tool.type === 'function' && tool.function?.name) {
        return tool.function.name;
      }
      
      // Si es un objeto con name directo
      if (tool.name) {
        return tool.name;
      }
      
      // Si es un objeto con description, usar la primera palabra como capability
      if (tool.description) {
        const firstWord = tool.description.split(' ')[0].toLowerCase();
        return firstWord;
      }
      
      // Si no tiene ninguno de los anteriores, usar el ID o un valor por defecto
      return tool.id || 'unknown_capability';
    });
    
    console.log(`🧠 [CapabilitiesExtractor] Capabilities extraídas de array: ${capabilities.join(', ')}`);
    return capabilities;
  }

  /**
   * Extrae capabilities de un objeto de herramientas
   */
  private static extractFromObject(tools: Record<string, any>, sourceDescription: string): string[] {
    console.log(`🧠 [CapabilitiesExtractor] Procesando objeto de tools para ${sourceDescription}`);
    
    const capabilities = Object.entries(tools).map(([key, tool]: [string, any]) => {
      // Si el tool es un objeto con name
      if (tool && typeof tool === 'object' && tool.name) {
        return tool.name;
      }
      
      // Si el tool es un objeto con función anidada
      if (tool && typeof tool === 'object' && tool.function?.name) {
        return tool.function.name;
      }
      
      // Si no tiene name ni función, usar la key
      return key;
    });
    
    console.log(`🧠 [CapabilitiesExtractor] Capabilities extraídas de objeto: ${capabilities.join(', ')}`);
    return capabilities;
  }

  /**
   * Combina capabilities de diferentes fuentes en un conjunto único
   */
  public static combineCapabilities(...capabilitiesSets: string[][]): string[] {
    const uniqueCapabilities = new Set<string>();
    
    capabilitiesSets.forEach(capabilities => {
      if (Array.isArray(capabilities)) {
        capabilities.forEach(cap => uniqueCapabilities.add(cap));
      }
    });
    
    return Array.from(uniqueCapabilities);
  }
} 