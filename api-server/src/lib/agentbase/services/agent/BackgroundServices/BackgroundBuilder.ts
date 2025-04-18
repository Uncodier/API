/**
 * BackgroundBuilder.ts
 * Clase para construir el texto de background del agente de manera estructurada
 */

export class BackgroundBuilder {
  /**
   * Construye el prompt del agente incorporando todas las fuentes de información disponibles
   */
  public static buildAgentPrompt(
    id: string,
    name: string,
    description: string,
    capabilities: string[],
    backstory?: string,
    systemPrompt?: string,
    agentPrompt?: string
  ): string {
    console.log(`🧩 [BackgroundBuilder] Construyendo prompt para ${name} (${id})`);
    console.log(`🧩 [BackgroundBuilder] AgentPrompt disponible: ${agentPrompt ? 'SÍ' : 'NO'} - Longitud: ${agentPrompt ? agentPrompt.length : 0}`);
    console.log(`🧩 [BackgroundBuilder] SystemPrompt disponible: ${systemPrompt ? 'SÍ' : 'NO'} - Longitud: ${systemPrompt ? systemPrompt.length : 0}`);
    console.log(`🧩 [BackgroundBuilder] Backstory disponible: ${backstory ? 'SÍ' : 'NO'} - Longitud: ${backstory ? backstory.length : 0}`);
    console.log(`🧩 [BackgroundBuilder] Capabilities recibidas (${capabilities.length}): ${capabilities.join(', ')}`);
    
    // Construir el prompt de forma estructurada por bloques
    const sections = [
      this.createIdentitySection(id, name),
      this.createBackstorySection(backstory),
      this.createDescriptionSection(description),
      this.createCapabilitiesSection(capabilities),
      this.createInstructionsSection(name),
      this.createSystemSection(systemPrompt),
      this.createCustomInstructionsSection(agentPrompt)
    ];
    
    // Unir todas las secciones, filtrando las vacías
    const finalPrompt = sections
      .filter(section => section.trim() !== '')
      .join('\n\n');
    
    console.log(`📏 [BackgroundBuilder] Longitud total del prompt generado: ${finalPrompt.length} caracteres`);
    
    // Verificaciones de control
    this.verifyPromptSections(finalPrompt, systemPrompt, agentPrompt, backstory);
    
    return finalPrompt;
  }
  
  /**
   * Crea la sección de identidad del agente
   */
  private static createIdentitySection(id: string, name: string): string {
    return `# Agent Identity\nYou are ${name} (ID: ${id}).`;
  }
  
  /**
   * Crea la sección de backstory si está disponible
   */
  private static createBackstorySection(backstory?: string): string {
    if (!backstory || !backstory.trim()) return '';
    
    console.log(`🔍 [BackgroundBuilder] Añadiendo backstory del agente: ${backstory.substring(0, 50)}...`);
    return `# Backstory\n${backstory}`;
  }
  
  /**
   * Crea la sección de descripción si está disponible
   */
  private static createDescriptionSection(description?: string): string {
    if (!description || !description.trim()) return '';
    
    return `# Description\n${description}`;
  }
  
  /**
   * Crea la sección de capabilities
   */
  private static createCapabilitiesSection(capabilities: string[]): string {
    const capabilitiesStr = capabilities.length > 0
      ? capabilities.join(', ') 
      : 'providing assistance';
    
    return `# Capabilities\nYour capabilities include: ${capabilitiesStr}.`;
  }
  
  /**
   * Crea la sección de instrucciones básicas
   */
  private static createInstructionsSection(name: string): string {
    return `# Instructions
1. Respond helpfully to user requests.
2. Use your capabilities effectively.
3. Be concise and clear in your responses.
4. Your name is "${name}" - whenever asked about your name, identity or what you are, respond with this name.`;
  }
  
  /**
   * Crea la sección de instrucciones del sistema si está disponible
   */
  private static createSystemSection(systemPrompt?: string): string {
    if (!systemPrompt || !systemPrompt.trim()) return '';
    
    console.log(`🔍 [BackgroundBuilder] Añadiendo systemPrompt: ${systemPrompt.substring(0, 50)}...`);
    return `# System Instructions\n${systemPrompt}`;
  }
  
  /**
   * Crea la sección de instrucciones personalizadas si está disponible
   */
  private static createCustomInstructionsSection(agentPrompt?: string): string {
    if (!agentPrompt || !agentPrompt.trim()) return '';
    
    console.log(`🔍 [BackgroundBuilder] Añadiendo prompt específico del agente: ${agentPrompt.substring(0, 50)}...`);
    return `# Agent Custom Instructions\n${agentPrompt}`;
  }
  
  /**
   * Verifica que el prompt contenga todas las secciones esperadas
   */
  private static verifyPromptSections(
    finalPrompt: string, 
    systemPrompt?: string, 
    agentPrompt?: string, 
    backstory?: string
  ): void {
    if (systemPrompt && !finalPrompt.includes('# System Instructions')) {
      console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir systemPrompt pero no se encontró en el prompt final`);
    }
    
    if (agentPrompt && !finalPrompt.includes('# Agent Custom Instructions')) {
      console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir las instrucciones personalizadas pero no se encontraron en el prompt final`);
    }
    
    if (backstory && !finalPrompt.includes('# Backstory')) {
      console.error(`⚠️ [BackgroundBuilder] ADVERTENCIA: Se esperaba incluir backstory pero no se encontró en el prompt final`);
    }
  }
  
  /**
   * Crea un background de emergencia en caso de error
   */
  public static createEmergencyBackground(id: string, name: string, capabilities: string[]): string {
    console.log(`⚠️ [BackgroundBuilder] Generando background mínimo de emergencia para: ${id}`);
    
    const fallbackCapabilities = capabilities.length > 0 
      ? capabilities 
      : ['providing assistance'];
    
    const emergencyBackground = `# Agent Identity
You are ${name} (ID: ${id}).

# Capabilities
Your capabilities include: ${Array.isArray(fallbackCapabilities) ? fallbackCapabilities.join(', ') : 'providing assistance'}.

# Instructions
1. Respond helpfully to user requests.
2. Use your capabilities effectively.
3. Be concise and clear in your responses.
4. Your name is "${name}" - whenever asked about your name, identity or what you are, respond with this name.`;
    
    console.log(`⚠️ [BackgroundBuilder] Background de emergencia generado (${emergencyBackground.length} caracteres)`);
    return emergencyBackground;
  }
} 