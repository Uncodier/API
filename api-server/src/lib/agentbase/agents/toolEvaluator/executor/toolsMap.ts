/**
 * Módulo para la gestión del mapa de herramientas
 * 
 * Este módulo proporciona la funcionalidad para crear y gestionar
 * un mapa de herramientas a partir de definiciones de herramientas.
 */

/**
 * Create a tools map from an array of tools
 * @param tools - Array of tools
 * @param requiredToolNames - Optional array of tool names that will be used (para optimización)
 * @returns Map of tool names to their implementation functions
 */
export function createToolsMap(tools: any[], requiredToolNames?: string[]): Record<string, any> {
  const toolsMap: Record<string, any> = {};
  
  if (!tools || !Array.isArray(tools) || tools.length === 0) {
    console.log(`[ToolExecutor] No hay herramientas disponibles para mapear`);
    return toolsMap;
  }
  
  // Si tenemos una lista de herramientas requeridas, mostrarla
  if (requiredToolNames && requiredToolNames.length > 0) {
    console.log(`[ToolExecutor] Creando mapa solo para las ${requiredToolNames.length} herramientas requeridas: ${requiredToolNames.join(', ')}`);
  } else {
    console.log(`[ToolExecutor] Creando mapa completo de ${tools.length} herramientas`);
  }
  
  for (const tool of tools) {
    // Intentar obtener el nombre de la herramienta de varias formas posibles
    const toolName = extractToolName(tool);
    
    if (!toolName) {
      console.warn(`[ToolExecutor] Herramienta sin nombre válido, omitiendo:`, tool);
      continue;
    }
    
    // Si tenemos una lista de herramientas requeridas y esta no está en ella, saltarla
    if (requiredToolNames && requiredToolNames.length > 0 && !requiredToolNames.includes(toolName)) {
      // Omitir esta herramienta ya que no está en la lista de requeridas
      continue;
    }
    
    console.log(`[ToolExecutor] Procesando herramienta: ${toolName}`);
    
    // Buscar la implementación en varias ubicaciones posibles
    if (tool.function && typeof tool.function === 'function') {
      toolsMap[toolName] = tool.function;
      console.log(`[ToolExecutor] Registrando implementación directa para ${toolName}`);
    } 
    else if (tool.handler && typeof tool.handler === 'function') {
      toolsMap[toolName] = tool.handler;
      console.log(`[ToolExecutor] Registrando handler para ${toolName}`);
    }
    else if (tool.function && tool.function.implementation && typeof tool.function.implementation === 'function') {
      toolsMap[toolName] = tool.function.implementation;
      console.log(`[ToolExecutor] Registrando implementation anidada para ${toolName}`);
    }
    else {
      // Si no hay una implementación real, no registrar la herramienta
      console.warn(`[ToolExecutor] No se encontró implementación para ${toolName}, OMITIENDO esta herramienta`);
      // No agregamos la herramienta al mapa, lo que provocará un error cuando se intente ejecutar
    }
  }
  
  // Registrar las herramientas encontradas
  const toolNames = Object.keys(toolsMap);
  if (toolNames.length > 0) {
    console.log(`[ToolExecutor] Mapa de herramientas creado con ${toolNames.length} entradas: ${toolNames.join(', ')}`);
  } else {
    console.warn(`[ToolExecutor] ⚠️ No se encontraron implementaciones válidas para las herramientas requeridas`);
  }
  
  return toolsMap;
}

/**
 * Extract the name of a tool from various possible locations
 */
function extractToolName(tool: any): string | null {
  // Posibles ubicaciones del nombre de la herramienta
  if (typeof tool === 'string') {
    return tool; // Si es directamente un string
  }
  
  if (!tool || typeof tool !== 'object') {
    return null; // Si no es un objeto, no podemos extraer un nombre
  }
  
  // Buscar en varias ubicaciones posibles
  if (tool.name) {
    return tool.name;
  }
  
  if (tool.function && tool.function.name) {
    return tool.function.name;
  }
  
  if (tool.type === 'function' && tool.function && tool.function.name) {
    return tool.function.name;
  }
  
  // Formato alternativo
  if (tool.id && typeof tool.id === 'string') {
    return tool.id;
  }
  
  return null; // No se encontró un nombre válido
} 