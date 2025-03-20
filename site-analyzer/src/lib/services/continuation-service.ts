import { analyzeWithConversationApi } from './conversation-client';

interface ContinuationOptions {
  incompleteJson: string;
  modelType: 'anthropic' | 'openai' | 'gemini';
  modelId: string;
  siteUrl: string;
  originalPrompt?: string; // Prompt original que generó el JSON incompleto
  includeScreenshot?: boolean;
  timeout?: number;
  maxRetries?: number;
  debugMode?: boolean;
  htmlContent?: string; // HTML content for analysis
}

interface ContinuationResult {
  success: boolean;
  completeJson: any;
  error?: string;
  retries?: number;
}

/**
 * Servicio para continuar la generación de JSON cuando un agente se queda sin contexto
 * y no puede completar la respuesta.
 */
export async function continueJsonGeneration(options: ContinuationOptions): Promise<ContinuationResult> {
  console.log('[ContinuationService] Iniciando continuación de JSON incompleto');
  
  const {
    incompleteJson,
    modelType,
    modelId,
    siteUrl,
    originalPrompt = '', // Prompt original, vacío por defecto
    includeScreenshot = false,
    timeout = 90000, // 90 segundos
    maxRetries = 3,
    debugMode = false
  } = options;

  // Verificar si el input es válido
  if (!incompleteJson || typeof incompleteJson !== 'string') {
    console.error('[ContinuationService] Input inválido:', incompleteJson);
    return {
      success: false,
      completeJson: null,
      error: 'El JSON proporcionado no es válido (no es un string)'
    };
  }

  // Intentar analizar el JSON incompleto para determinar dónde se cortó
  let parsedIncomplete: any;
  let isValidJson = false;
  
  try {
    parsedIncomplete = JSON.parse(incompleteJson);
    isValidJson = true;
    console.log('[ContinuationService] El JSON proporcionado es válido y completo');
    
    // Si llegamos aquí, el JSON ya es válido, así que lo devolvemos
    return {
      success: true,
      completeJson: parsedIncomplete
    };
  } catch (error: any) {
    console.log('[ContinuationService] JSON incompleto o inválido:', error.message);
    
    // Continuar con el proceso de recuperación
  }

  // Función para limpiar el JSON incompleto y prepararlo para la continuación
  const cleanIncompleteJson = (json: string): string => {
    // Eliminar cualquier carácter no válido al final que pueda causar problemas
    let cleaned = json.trim();
    
    // Si termina con una coma seguida de comillas, eliminar la coma
    cleaned = cleaned.replace(/,\s*"[^"]*$/, '"');
    
    // Si termina con una coma, eliminarla
    cleaned = cleaned.replace(/,\s*$/, '');
    
    // Si termina con una llave abierta o corchete abierto sin contenido, cerrarlos
    if (cleaned.endsWith('{')) {
      cleaned = cleaned + '}';
    } else if (cleaned.endsWith('[')) {
      cleaned = cleaned + ']';
    }
    
    // Intentar cerrar llaves y corchetes no balanceados
    const openBraces = (cleaned.match(/{/g) || []).length;
    const closeBraces = (cleaned.match(/}/g) || []).length;
    const openBrackets = (cleaned.match(/\[/g) || []).length;
    const closeBrackets = (cleaned.match(/\]/g) || []).length;
    
    // Añadir llaves de cierre faltantes
    for (let i = 0; i < openBraces - closeBraces; i++) {
      cleaned = cleaned + '}';
    }
    
    // Añadir corchetes de cierre faltantes
    for (let i = 0; i < openBrackets - closeBrackets; i++) {
      cleaned = cleaned + ']';
    }
    
    return cleaned;
  };

  // Función para concatenar inteligentemente el JSON incompleto con la continuación
  const smartConcatenate = (incompleteJson: string, continuationPart: string): string => {
    // Limpiar la continuación de posibles caracteres no deseados
    continuationPart = continuationPart.trim();
    
    // Mejorar la concatenación para manejar casos especiales
    let combinedJson = '';
    
    // Verificar si el JSON incompleto termina con una cadena cortada
    const endsWithQuote = incompleteJson.trim().endsWith('"');
    const startsWithQuote = continuationPart.trim().startsWith('"');
    
    // Caso especial: Detectar palabras cortadas en medio de cadenas de texto
    // Por ejemplo: "Greater New" y "York City Area"
    const lastQuotePos = incompleteJson.trim().lastIndexOf('"');
    const firstQuotePos = continuationPart.trim().indexOf('"');
    
    // Si hay una comilla al final del incompleto y una comilla al principio de la continuación
    // y hay texto entre ellas, podría ser una cadena cortada
    if (lastQuotePos !== -1 && firstQuotePos !== -1 && 
        lastQuotePos === incompleteJson.trim().length - 1 && firstQuotePos > 0) {
      
      console.log('[ContinuationService] Posible cadena de texto cortada detectada');
      
      // Extraer las partes de la cadena
      const lastPart = incompleteJson.trim().substring(lastQuotePos - 20, lastQuotePos);
      const firstPart = continuationPart.trim().substring(0, firstQuotePos + 1);
      
      console.log('[ContinuationService] Final del incompleto:', lastPart);
      console.log('[ContinuationService] Inicio de la continuación:', firstPart);
      
      // Buscar palabras que podrían estar cortadas
      const lastWords = lastPart.split(' ');
      const firstWords = firstPart.split(' ');
      
      if (lastWords.length > 0 && firstWords.length > 0) {
        const lastWord = lastWords[lastWords.length - 1];
        
        // Buscar si alguna de las primeras palabras de la continuación comienza con la última palabra del incompleto
        let foundMatch = false;
        
        for (let i = 0; i < Math.min(3, firstWords.length); i++) {
          if (firstWords[i].startsWith(lastWord)) {
            foundMatch = true;
            break;
          }
        }
        
        if (foundMatch) {
          console.log('[ContinuationService] Detectada posible palabra cortada');
          
          // Intentar una concatenación especial para este caso
          // Eliminar la comilla del final del incompleto y la comilla del inicio de la continuación
          if (endsWithQuote && startsWithQuote) {
            const trimmedIncomplete = incompleteJson.trim().slice(0, -1);
            const trimmedContinuation = continuationPart.trim().slice(1);
            combinedJson = trimmedIncomplete + trimmedContinuation;
            console.log('[ContinuationService] Reparada concatenación de cadena cortada');
          } else {
            // Si no podemos hacer la reparación especial, usar la concatenación normal
            combinedJson = incompleteJson.trim() + continuationPart.trim();
          }
        } else {
          // No parece ser una palabra cortada, usar concatenación normal
          combinedJson = incompleteJson.trim() + continuationPart.trim();
        }
      } else {
        // No hay suficientes palabras para analizar, usar concatenación normal
        combinedJson = incompleteJson.trim() + continuationPart.trim();
      }
    }
    // Caso 1: Si el JSON incompleto termina con comilla y la continuación comienza con comilla,
    // es probable que sea una cadena cortada en medio de una palabra
    else if (endsWithQuote && startsWithQuote) {
      // Eliminar una de las comillas para evitar duplicación
      const trimmedIncomplete = incompleteJson.trim().slice(0, -1);
      const trimmedContinuation = continuationPart.trim().slice(1);
      combinedJson = trimmedIncomplete + trimmedContinuation;
      console.log('[ContinuationService] Detectada cadena cortada con comillas, reparando concatenación');
    }
    // Caso 2: Concatenación normal para otros casos
    else {
      combinedJson = incompleteJson.trim() + continuationPart.trim();
      console.log('[ContinuationService] Concatenación normal');
    }
    
    // Verificar si hay comillas duplicadas en la concatenación
    while (combinedJson.includes('""')) {
      combinedJson = combinedJson.replace('""', '"');
    }
    
    // Verificar si hay comas duplicadas
    while (combinedJson.includes(',,')) {
      combinedJson = combinedJson.replace(',,', ',');
    }
    
    // Verificar si hay corchetes o llaves mal formados
    combinedJson = combinedJson.replace('][', '],[');
    combinedJson = combinedJson.replace('}{', '},{');
    
    // Verificar si hay espacios duplicados
    while (combinedJson.includes('  ')) {
      combinedJson = combinedJson.replace('  ', ' ');
    }
    
    // Restaurar espacios en formato JSON normal
    combinedJson = combinedJson.replace('" "', '", "');
    combinedJson = combinedJson.replace('" {', '", {');
    combinedJson = combinedJson.replace('} "', '}, "');
    combinedJson = combinedJson.replace('] "', '], "');
    combinedJson = combinedJson.replace('" [', '", [');
    
    console.log('[ContinuationService] JSON concatenado (últimos 50 caracteres):', 
      combinedJson.substring(Math.max(0, combinedJson.length - 50), combinedJson.length));
    
    return combinedJson;
  };

  // Intentar reparar el JSON para ver si podemos determinar la estructura
  const cleanedJson = cleanIncompleteJson(incompleteJson);
  let partialStructure: any;
  
  try {
    partialStructure = JSON.parse(cleanedJson);
    console.log('[ContinuationService] Se pudo reparar el JSON para análisis:', Object.keys(partialStructure));
    
    // Si pudimos reparar el JSON, podríamos devolverlo directamente
    // pero vamos a verificar si parece completo
    if (partialStructure && typeof partialStructure === 'object') {
      // Verificar si el objeto tiene las propiedades esperadas para un análisis de segmento
      if (partialStructure.segments && Array.isArray(partialStructure.segments)) {
        console.log('[ContinuationService] El JSON reparado parece completo, devolviéndolo');
        return {
          success: true,
          completeJson: partialStructure
        };
      }
    }
  } catch (error) {
    console.log('[ContinuationService] No se pudo reparar el JSON para análisis, continuando con el proceso');
    partialStructure = {};
  }

  // Extraer un fragmento del JSON incompleto para el prompt
  // Si el JSON es muy grande, solo usamos una parte para el prompt
  const maxJsonLengthForPrompt = 8000; // Limitar el tamaño del JSON en el prompt
  let jsonForPrompt = incompleteJson;
  
  if (incompleteJson.length > maxJsonLengthForPrompt) {
    // Si el JSON es muy grande, usar solo el principio y el final
    const startPart = incompleteJson.substring(0, maxJsonLengthForPrompt / 2);
    const endPart = incompleteJson.substring(incompleteJson.length - maxJsonLengthForPrompt / 2);
    jsonForPrompt = `${startPart}\n\n... [JSON truncado para el prompt] ...\n\n${endPart}`;
    console.log(`[ContinuationService] JSON truncado para el prompt (${incompleteJson.length} -> ${jsonForPrompt.length} caracteres)`);
  }

  // Preparar el prompt para continuar la generación
  const preparePrompt = (incomplete: string): string => {
    let prompt = `Necesito que completes el siguiente JSON que quedó incompleto debido a limitaciones de contexto. 
Por favor, continúa exactamente desde donde se quedó y genera SOLO la parte faltante.

`;

    // Incluir el prompt original si está disponible
    if (originalPrompt && originalPrompt.trim().length > 0) {
      prompt += `PROMPT ORIGINAL QUE GENERÓ ESTE JSON:
"""
${originalPrompt}
"""

`;
    }

    // Include HTML content if available to help with continuation
    if (options.htmlContent) {
      // Limit HTML size to prevent token limit issues
      const maxHtmlLength = 15000; // ~8K tokens for HTML
      const truncatedHtml = options.htmlContent.length > maxHtmlLength 
        ? options.htmlContent.substring(0, maxHtmlLength) + '... [HTML truncado para el prompt] ...' 
        : options.htmlContent;
      
      prompt += `NOTA: Para ayudarte a continuar el análisis, aquí está el HTML del sitio ${siteUrl}:
\`\`\`html
${truncatedHtml}
\`\`\`

`;
    }

    prompt += `JSON INCOMPLETO:
\`\`\`json
${incomplete}
\`\`\`

INSTRUCCIONES:
1. Analiza la estructura del JSON incompleto.
2. Continúa generando SOLO la parte faltante del JSON, comenzando exactamente donde se cortó.
3. NO repitas ninguna parte que ya esté en el JSON incompleto.
4. Responde ÚNICAMENTE con la parte faltante, sin el JSON inicial.
5. No incluyas marcadores de código como \`\`\`json o \`\`\` en tu respuesta.
6. Si el JSON ya parece estar completo, responde con "JSON_YA_COMPLETO".
7. IMPORTANTE: Tómate tu tiempo para generar una continuación coherente con la estructura existente.

Ejemplo:
Si el JSON incompleto es: {"data": {"items": [{"id": 1, "name": "Item 1"}, {"id": 2, "name":
Tu respuesta debería ser solo: "Item 2"}, {"id": 3, "name": "Item 3"}]}}

IMPORTANTE: Tu respuesta debe ser SOLO la parte faltante, no el JSON completo.`;

    return prompt;
  };

  // Realizar intentos para completar el JSON
  let retries = 0;
  let success = false;
  let completeJson: any = null;
  let lastError: string = '';
  
  // Variable para almacenar el ID de conversación para continuación
  let conversationId: string | undefined;

  // Función auxiliar para verificar si una conversación está cerrada o no
  const isConversationClosed = (response: any): boolean => {
    if (!response || typeof response !== 'object') return true; // Asumir cerrado por defecto
    
    try {
      // Verificar si existe _requestMetadata y closed de manera segura
      if (!response.hasOwnProperty('_requestMetadata')) return true;
      if (typeof response._requestMetadata !== 'object' || response._requestMetadata === null) return true;
      if (!response._requestMetadata.hasOwnProperty('closed')) return true;
      
      // La conversación no está cerrada solo si closed es explícitamente false
      return response._requestMetadata.closed !== false;
    } catch (e) {
      // Si hay algún error, asumir que está cerrado
      return true;
    }
  };
  
  // Función auxiliar para extraer el ID de conversación
  const getConversationId = (response: any): string | undefined => {
    if (!response || typeof response !== 'object') return undefined;
    
    try {
      // Verificar si existe _requestMetadata y conversationId de manera segura
      if (!response.hasOwnProperty('_requestMetadata')) return undefined;
      if (typeof response._requestMetadata !== 'object' || response._requestMetadata === null) return undefined;
      if (!response._requestMetadata.hasOwnProperty('conversationId')) return undefined;
      
      return response._requestMetadata.conversationId;
    } catch (e) {
      // Si hay algún error, devolver undefined
      return undefined;
    }
  };

  // Bucle principal de reintentos
  while (retries < maxRetries && !success) {
    try {
      console.log(`[ContinuationService] Intento ${retries + 1} de ${maxRetries}`);
      
      const prompt = preparePrompt(jsonForPrompt);
      
      // Usar un timeout más largo para la continuación
      const continuationTimeout = timeout * (1.5 + (retries * 0.1)); // Aumentar 10% por cada intento
      console.log(`[ContinuationService] Usando timeout extendido para continuación: ${continuationTimeout}ms`);
      
      // Añadir espera creciente entre intentos
      if (retries > 0) {
        const waitTime = 1000 * retries; // Espera creciente: 1s, 2s, 3s...
        console.log(`[ContinuationService] Esperando ${waitTime}ms antes del intento ${retries + 1}...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
      // Añadir un mensaje de log para indicar que estamos esperando la respuesta
      console.log(`[ContinuationService] Esperando respuesta del modelo (timeout: ${continuationTimeout}ms)...`);
      
      // Si tenemos un ID de conversación, utilizarlo para la continuación
      const response = await analyzeWithConversationApi(
        prompt,
        modelType,
        modelId,
        siteUrl,
        includeScreenshot,
        continuationTimeout, // Usar un timeout más largo para la continuación
        debugMode,
        true, // Siempre solicitar JSON
        conversationId // Usar el conversationId si está disponible
      );
      
      console.log(`[ContinuationService] Respuesta recibida del modelo, procesando...`);
      
      // Verificar si la respuesta contiene metadatos y un ID de conversación
      if (response && typeof response === 'object') {
        const respConversationId = getConversationId(response);
        const isClosed = isConversationClosed(response);
        
        if (respConversationId) {
          console.log('[ContinuationService] Respuesta contiene ID de conversación:', respConversationId);
          conversationId = respConversationId;
        }
        
        if (!isClosed) {
          console.log('[ContinuationService] Conversación marcada como no cerrada, se requerirá continuación');
        } else {
          console.log('[ContinuationService] Conversación marcada como cerrada, probablemente el JSON está completo');
        }
      }
      
      // Verificar si la respuesta es un string (posiblemente JSON)
      if (typeof response === 'string') {
        try {
          // Verificar si la respuesta indica que el JSON ya está completo
          if (response.trim() === "JSON_YA_COMPLETO") {
            try {
              completeJson = JSON.parse(incompleteJson);
              success = true;
              console.log('[ContinuationService] El JSON ya estaba completo según el modelo');
            } catch (parseError) {
              lastError = `El JSON original no es válido a pesar de que el modelo indica que está completo`;
              console.error('[ContinuationService] Error al analizar el JSON original:', parseError);
            }
          } else {
            // Intentar extraer la continuación de la respuesta si está en formato markdown
            let continuationPart = response;
            const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
              continuationPart = jsonMatch[1];
            }
            
            // Usar la función de concatenación inteligente
            const combinedJson = smartConcatenate(incompleteJson, continuationPart);
            
            try {
              completeJson = JSON.parse(combinedJson);
              success = true;
              console.log('[ContinuationService] JSON concatenado y parseado correctamente');
            } catch (parseError: any) {
              lastError = `Error al concatenar y parsear el JSON: ${parseError.message}`;
              console.error('[ContinuationService] Error al concatenar y parsear:', parseError);
              console.log('[ContinuationService] JSON incompleto:', incompleteJson.substring(incompleteJson.length - 100));
              console.log('[ContinuationService] Continuación:', continuationPart.substring(0, 100));
              
              // Intentar reparar el JSON concatenado
              try {
                const repairedCombined = cleanIncompleteJson(combinedJson);
                completeJson = JSON.parse(repairedCombined);
                success = true;
                console.log('[ContinuationService] Se pudo reparar el JSON concatenado');
              } catch (repairError) {
                console.error('[ContinuationService] No se pudo reparar el JSON concatenado');
                
                // Último intento: tratar la respuesta como un JSON completo
                try {
                  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                  const jsonString = jsonMatch ? jsonMatch[1] : response;
                  
                  completeJson = JSON.parse(jsonString);
                  success = true;
                  console.log('[ContinuationService] Usando la respuesta como JSON completo (fallback)');
                } catch (finalError) {
                  console.error('[ContinuationService] No se pudo usar la respuesta como JSON completo');
                  
                  // Si tenemos un ID de conversación y no está marcada como cerrada, 
                  // probablemente necesitemos continuar la conversación en el siguiente intento
                  if (!isConversationClosed(response)) {
                    console.log('[ContinuationService] La conversación no está cerrada, continuaremos en el siguiente intento');
                  }
                }
              }
            }
          }
        } catch (parseError: any) {
          lastError = `La respuesta no es un JSON válido: ${parseError.message}`;
          console.error('[ContinuationService] Error al analizar respuesta como JSON:', parseError);
          
          // Intentar reparar el JSON de la respuesta
          try {
            const repairedResponse = cleanIncompleteJson(response);
            completeJson = JSON.parse(repairedResponse);
            success = true;
            console.log('[ContinuationService] Se pudo reparar la respuesta JSON');
          } catch (repairError) {
            console.error('[ContinuationService] No se pudo reparar la respuesta JSON');
          }
        }
      } else if (response && typeof response === 'object') {
        // Verificar si la respuesta está marcada como no cerrada
        if (!isConversationClosed(response) && conversationId) {
          console.log('[ContinuationService] La conversación no está cerrada, intentaremos continuar en el siguiente intento');
          
          // Intentar extraer el contenido parcial para la próxima iteración
          let content = '';
          if ('content' in response && typeof response.content === 'string') {
            content = response.content;
          } else if ('choices' in response && Array.isArray(response.choices) && 
                     response.choices[0] && 'message' in response.choices[0] && 
                     response.choices[0].message && 'content' in response.choices[0].message) {
            content = response.choices[0].message.content as string;
          }
          
          // Actualizar jsonForPrompt solo si tenemos algo útil
          if (content && content.trim().length > 0) {
            // Intentar concatenar lo que tenemos hasta ahora
            try {
              const combinedJson = smartConcatenate(incompleteJson, content);
              jsonForPrompt = combinedJson;
              console.log('[ContinuationService] Actualizando el JSON para el próximo intento');
            } catch (concatError) {
              console.error('[ContinuationService] Error al actualizar el JSON para el próximo intento:', concatError);
            }
          }
        }
      }
      
      retries++;
    } catch (error: any) {
      retries++;
      lastError = `Error en la solicitud: ${error.message || 'Error desconocido'}`;
      console.error(`[ContinuationService] Error en intento ${retries}:`, error);
      
      // Añadir espera creciente después de un error
      const waitTime = 2000 * retries; // Espera más larga después de un error: 2s, 4s, 6s...
      console.log(`[ContinuationService] Esperando ${waitTime}ms después del error...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  if (success) {
    console.log('[ContinuationService] JSON completado exitosamente');
    return {
      success: true,
      completeJson,
      retries
    };
  } else {
    console.error('[ContinuationService] No se pudo completar el JSON después de', retries, 'intentos');
    
    // Último intento: devolver el JSON reparado si existe
    if (partialStructure && Object.keys(partialStructure).length > 0) {
      console.log('[ContinuationService] Devolviendo JSON parcialmente reparado como último recurso');
      return {
        success: true,
        completeJson: partialStructure,
        error: 'JSON parcialmente reparado, puede estar incompleto',
        retries
      };
    }
    
    return {
      success: false,
      completeJson: null,
      error: lastError || 'No se pudo completar el JSON después de varios intentos',
      retries
    };
  }
}

/**
 * Verifica si un string JSON está incompleto
 * @param jsonString String JSON a verificar
 * @returns true si el JSON está incompleto, false si es válido
 */
export function isIncompleteJson(jsonString: string): boolean {
  try {
    JSON.parse(jsonString);
    return false; // El JSON es válido
  } catch (error) {
    return true; // El JSON está incompleto o es inválido
  }
}

/**
 * Intenta reparar un JSON incompleto para hacerlo válido
 * @param incompleteJson JSON incompleto
 * @returns JSON reparado o null si no se pudo reparar
 */
export function attemptJsonRepair(incompleteJson: string): any | null {
  try {
    // Primero intentar analizar tal cual
    return JSON.parse(incompleteJson);
  } catch (error) {
    // Intentar limpiar y reparar
    try {
      // Eliminar cualquier carácter no válido al final
      let cleaned = incompleteJson.trim();
      
      // Si termina con una coma seguida de comillas, eliminar la coma
      cleaned = cleaned.replace(/,\s*"[^"]*$/, '"');
      
      // Si termina con una coma, eliminarla
      cleaned = cleaned.replace(/,\s*$/, '');
      
      // Contar llaves y corchetes para balancearlos
      const openBraces = (cleaned.match(/{/g) || []).length;
      const closeBraces = (cleaned.match(/}/g) || []).length;
      const openBrackets = (cleaned.match(/\[/g) || []).length;
      const closeBrackets = (cleaned.match(/\]/g) || []).length;
      
      // Añadir llaves de cierre faltantes
      for (let i = 0; i < openBraces - closeBraces; i++) {
        cleaned = cleaned + '}';
      }
      
      // Añadir corchetes de cierre faltantes
      for (let i = 0; i < openBrackets - closeBrackets; i++) {
        cleaned = cleaned + ']';
      }
      
      return JSON.parse(cleaned);
    } catch (repairError) {
      return null; // No se pudo reparar
    }
  }
} 