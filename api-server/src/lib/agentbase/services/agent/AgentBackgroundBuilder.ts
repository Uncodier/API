/**
 * AgentBackgroundBuilder - Servicio para construir backgrounds para los agentes
 */
import { Base } from '../../agents/Base';

export class AgentBackgroundBuilder {
  // Método para construir el prompt del agente de manera consistente
  public buildAgentPrompt(
    id: string,
    name: string,
    description: string,
    capabilities: string[],
    backstory?: string,
    agentPrompt?: string
  ): string {
    console.log(`🧩 Construyendo prompt para ${name} (${id})`);
    console.log(`🧩 AgentPrompt disponible: ${agentPrompt ? 'SÍ' : 'NO'} - Longitud: ${agentPrompt ? agentPrompt.length : 0}`);
    console.log(`🧩 Backstory disponible: ${backstory ? 'SÍ' : 'NO'} - Longitud: ${backstory ? backstory.length : 0}`);
    
    // Construir el prompt de forma estructurada, asegurándonos de incluir todos los elementos
    let finalPrompt = '';

    // 1. Bloque de identidad - Siempre incluir nombre e ID
    finalPrompt += `# Agent Identity\nYou are ${name} (ID: ${id}).\n\n`;
    
    // 2. Bloque de descripción - Si está disponible
    if (description && description.trim()) {
      finalPrompt += `# Description\n${description}\n\n`;
    }
    
    // 3. Bloque de capacidades - Listarlas formalmente
    const capabilitiesStr = Array.isArray(capabilities) 
      ? capabilities.join(', ') 
      : 'providing assistance';
    
    finalPrompt += `# Capabilities\nYour capabilities include: ${capabilitiesStr}.\n\n`;
    
    // 4. Bloque de instrucciones - Siempre incluir instrucciones básicas
    finalPrompt += `# Instructions\n`;
    finalPrompt += `1. Respond helpfully to user requests.\n`;
    finalPrompt += `2. Use your capabilities effectively.\n`;
    finalPrompt += `3. Be concise and clear in your responses.\n`;
    finalPrompt += `4. Your name is "${name}" - whenever asked about your name, identity or what you are, respond with this name.\n\n`;
    
    // 5. Bloque de prompt específico del agente - Si está disponible
    // El agentPrompt contiene instrucciones específicas del agente que deben tener prioridad
    if (agentPrompt && agentPrompt.trim()) {
      console.log(`🔍 Añadiendo prompt específico del agente (agent.prompt): ${agentPrompt.substring(0, 50)}...`);
      finalPrompt += `# Agent Custom Instructions\n${agentPrompt}\n\n`;
    }
    
    // 6. Bloque de backstory - Si está disponible y no duplica instrucciones
    if (backstory && backstory.trim()) {
      // Verificar si el backstory ya contiene instrucciones similares para evitar duplicación
      const hasInstructions = backstory.toLowerCase().includes('instructions') || 
                            backstory.toLowerCase().includes('your name is');
      
      if (hasInstructions) {
        console.log(`🔍 El backstory ya contiene instrucciones, integrando cuidadosamente`);
        finalPrompt += `# Backstory/Specific Instructions\n${backstory}\n\n`;
      } else {
        console.log(`🔍 Añadiendo backstory sin sección de instrucciones duplicada`);
        finalPrompt += `# Backstory\n${backstory}\n\n`;
      }
    }
    
    console.log(`📏 Longitud total del prompt generado: ${finalPrompt.length} caracteres`);
    console.log(`📋 Estructura del prompt generado:\n${finalPrompt.split('\n').slice(0, 5).join('\n')}...\n(truncado para logs)`);
    
    // Verificar si el prompt contiene las secciones esperadas
    const containsAgentInstructions = finalPrompt.includes('# Agent Custom Instructions');
    if (agentPrompt && !containsAgentInstructions) {
      console.error(`⚠️ ADVERTENCIA: Se esperaba incluir las instrucciones personalizadas pero no se encontraron en el prompt final`);
    }
    
    return finalPrompt;
  }

  // Añadir los archivos del agente al background si existen
  public async appendAgentFilesToBackground(background: string, files: any[]): Promise<string> {
    // Implementación básica, añade información de archivos al background
    if (!files || files.length === 0) {
      return background;
    }
    
    let result = background + "\n\nYou have access to the following files:";
    
    for (const file of files) {
      if (file.name && file.content) {
        result += `\n- ${file.name}: ${file.description || 'No description provided'}`;
      }
    }
    
    return result;
  }

  // Construir el background completo del agente - Método público para usar en todos lados
  public createFullAgentBackground(
    id: string,
    name: string,
    description: string,
    capabilities: string[],
    backstory?: string,
    agentPrompt?: string
  ): string {
    console.log(`🔄 Creando background completo para agente ${name} (${id})`);
    
    // Usar buildAgentPrompt para construir el prompt completo
    const background = this.buildAgentPrompt(
      id,
      name,
      description,
      capabilities,
      backstory,
      agentPrompt
    );
    
    // Log detallado para verificar la construcción
    console.log(`✅ Background generado correctamente para ${name}`);
    console.log(`📏 Longitud total: ${background.length} caracteres`);
    console.log(`🔍 Contiene sección Agent Custom Instructions: ${background.includes('# Agent Custom Instructions')}`);
    
    return background;
  }
}

export default new AgentBackgroundBuilder(); 