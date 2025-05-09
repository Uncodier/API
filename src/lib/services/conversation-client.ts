import { ConversationOptions } from '@/lib/types/conversation-types';
import { processConversation } from '@/app/api/conversation/route';

/**
 * Construye una URL absoluta de manera segura para uso en el servidor
 * 
 * @param path Ruta relativa (por ejemplo, '/api/conversation')
 * @param baseUrl URL base (por ejemplo, 'http://localhost:3000')
 * @returns URL absoluta como string
 */
function buildServerUrl(path: string, baseUrl?: string): string {
  // Usar la URL base proporcionada o el valor predeterminado
  const base = baseUrl || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  
  try {
    // Intentar construir una URL válida
    const url = new URL(path, base);
    return url.toString();
  } catch (error) {
    console.error(`[Conversation Client] Error al construir URL (${base}, ${path}):`, error);
    
    // Fallback: concatenar manualmente asegurándose de que haya un solo '/'
    const baseWithSlash = base.endsWith('/') ? base : `${base}/`;
    const pathWithoutSlash = path.startsWith('/') ? path.substring(1) : path;
    return `${baseWithSlash}${pathWithoutSlash}`;
  }
}

export async function sendConversationRequest(options: ConversationOptions): Promise<any> {
  console.log('[Conversation Client] Iniciando solicitud con opciones:', JSON.stringify({
    modelType: options.modelType,
    modelId: options.modelId,
    includeScreenshot: options.includeScreenshot,
    siteUrl: options.siteUrl,
    responseFormat: options.responseFormat,
    messagesCount: options.messages?.length,
    timeout: options.timeout,
    toJSON: true
  }));

  // Validar opciones requeridas
  if (!options.messages || !Array.isArray(options.messages) || options.messages.length === 0) {
    console.error('[Conversation Client] Error: Se requiere al menos un mensaje');
    throw new Error('Se requiere al menos un mensaje');
  }

  if (!options.modelType) {
    console.error('[Conversation Client] Error: Se requiere el tipo de modelo');
    throw new Error('Se requiere el tipo de modelo');
  }

  if (!options.modelId) {
    console.error('[Conversation Client] Error: Se requiere el ID del modelo');
    throw new Error('Se requiere el ID del modelo');
  }

  // Usar un timeout mínimo de 120 segundos (2 minutos) para respuestas grandes
  const effectiveTimeout = Math.max(options.timeout || 45000, 120000);
  console.log(`[Conversation Client] Usando timeout efectivo: ${effectiveTimeout}ms`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(`[Conversation Client] Timeout excedido (${effectiveTimeout}ms)`);
    controller.abort();
  }, effectiveTimeout);

  try {
    console.log('[Conversation Client] Preparando cuerpo de la solicitud');
    const requestBody = {
      messages: options.messages,
      modelType: options.modelType,
      modelId: options.modelId,
      includeScreenshot: options.includeScreenshot,
      siteUrl: options.siteUrl,
      responseFormat: options.responseFormat,
      timeout: effectiveTimeout // Pasar el timeout efectivo al servidor
    };

    console.log('[Conversation Client] Cuerpo de la solicitud:', JSON.stringify(requestBody));

    try {
      // Determinar si estamos en el cliente o en el servidor
      const isServer = typeof window === 'undefined';
      let apiUrl;
      
      // Si estamos en el servidor, necesitamos una URL absoluta
      if (isServer) {
        // Usar la función de utilidad para construir la URL
        apiUrl = buildServerUrl('/api/conversation');
        console.log(`[Conversation Client] Ejecutando en servidor, usando URL absoluta: ${apiUrl}`);
      } else {
        // En el cliente, podemos usar una URL relativa
        apiUrl = '/api/conversation';
        console.log('[Conversation Client] Ejecutando en cliente, usando URL relativa: /api/conversation');
      }
      
      console.log(`[Conversation Client] Enviando solicitud a ${apiUrl}`);
      const startTime = Date.now();
      
      console.log(`[Conversation Client] Esperando respuesta (timeout: ${effectiveTimeout}ms)...`);
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      
      const duration = Date.now() - startTime;
      console.log(`[Conversation Client] Respuesta recibida en ${duration}ms con status: ${response.status}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Conversation Client] Error HTTP ${response.status}:`, errorText);
        throw new Error(`Error HTTP ${response.status}: ${errorText}`);
      }
      
      console.log(`[Conversation Client] Leyendo cuerpo de la respuesta...`);
      const responseText = await response.text();
      console.log(`[Conversation Client] Respuesta recibida (longitud: ${responseText.length} caracteres, primeros 100 caracteres): ${responseText.substring(0, 100)}...`);
      
      try {
        console.log('[Conversation Client] Analizando respuesta como JSON');
        const data = JSON.parse(responseText);
        
        // Añadir metadatos de la solicitud
        data._requestMetadata = {
          timestamp: new Date().toISOString(),
          duration: duration,
          modelType: options.modelType,
          modelId: options.modelId,
          siteUrl: options.siteUrl,
          includeScreenshot: options.includeScreenshot,
          responseLength: responseText.length
        };
        
        return data;
      } catch (parseError) {
        console.error(`[Conversation Client] Error al analizar respuesta como JSON:`, parseError);
        console.error(`[Conversation Client] Primeros 200 caracteres de la respuesta:`, responseText.substring(0, 200));
        
        // Si no podemos parsear como JSON, devolver el texto para que el servicio de continuación pueda intentar repararlo
        console.log(`[Conversation Client] Devolviendo respuesta como texto para procesamiento posterior`);
        return responseText;
      }
    } catch (fetchError: any) {
      console.error(`[Conversation Client] Error al llamar a la API de conversación:`, fetchError);
      
      // Verificar si es un error de timeout
      if (fetchError.name === 'AbortError') {
        console.error(`[Conversation Client] La solicitud fue abortada por timeout (${effectiveTimeout}ms)`);
        throw new Error(`Timeout excedido (${effectiveTimeout}ms). La respuesta es demasiado grande o el servidor está tardando demasiado en responder.`);
      }
      
      // Propagar el error para que sea manejado por el llamador
      throw new Error(`Error al llamar a la API de conversación: ${fetchError.message || 'Error desconocido'}`);
    }
  } catch (error: any) {
    console.error(`[Conversation Client] Error en solicitud:`, error);
    if (error.name === 'AbortError') {
      throw new Error(`Timeout excedido (${effectiveTimeout}ms). Intente aumentar el timeout o reducir la complejidad del análisis.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function analyzeWithConversationApi(
  prompt: string,
  provider: 'anthropic' | 'openai' | 'gemini',
  modelId: string,
  siteUrl: string,
  includeScreenshot: boolean = true,
  timeout: number = 120000, // Aumentado a 120 segundos (2 minutos)
  debugMode: boolean = false,
  toJSON: boolean = true,
  conversationId?: string // Nuevo parámetro para mantener el contexto de la conversación
): Promise<any> {
  console.log('[Conversation Client] analyzeWithConversationApi - Iniciando análisis con parámetros:', {
    provider,
    modelId,
    siteUrl,
    includeScreenshot,
    timeout,
    debugMode,
    toJSON,
    conversationId, // Añadir a los logs
    promptLength: prompt?.length,
    isServer: typeof window === 'undefined',
    baseUrl: typeof window === 'undefined' ? (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000') : window.location.origin
  });

  if (!prompt) {
    console.error('[Conversation Client] Error: Se requiere un prompt');
    throw new Error('Se requiere un prompt para el análisis');
  }

  if (!provider) {
    console.error('[Conversation Client] Error: Se requiere el tipo de modelo');
    throw new Error('Se requiere el tipo de modelo');
  }

  if (!modelId) {
    console.error('[Conversation Client] Error: Se requiere el ID del modelo');
    throw new Error('Se requiere el ID del modelo');
  }

  try {
    console.log('[Conversation Client] Preparando opciones para la conversación');
    
    const options: ConversationOptions = {
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      modelType: provider,
      modelId,
      siteUrl,
      includeScreenshot,
      responseFormat: toJSON ? 'json' : 'text',
      timeout,
      conversationId // Añadir el ID de conversación si está disponible
    };

    console.log('[Conversation Client] Opciones preparadas:', JSON.stringify({
      modelType: options.modelType,
      modelId: options.modelId,
      siteUrl: options.siteUrl,
      includeScreenshot: options.includeScreenshot,
      responseFormat: options.responseFormat,
      timeout: options.timeout,
      conversationId: options.conversationId, // Añadir a los logs
      messagesCount: options.messages.length
    }));

    // Si estamos en modo debug, mostrar el prompt completo
    if (debugMode) {
      console.log('[Conversation Client] Prompt completo:', prompt);
    }

    // Determinar si estamos en el cliente o en el servidor
    const isServer = typeof window === 'undefined';
    
    try {
      let response;
      
      if (isServer) {
        // En el servidor, usar directamente la función processConversation
        console.log('[Conversation Client] Ejecutando en servidor, usando processConversation directamente');
        console.log(`[Conversation Client] Esperando respuesta de processConversation (timeout: ${timeout}ms)...`);
        response = await processConversation(options);
        console.log('[Conversation Client] Respuesta recibida de processConversation');
      } else {
        // En el cliente, usar la API normal
        console.log('[Conversation Client] Ejecutando en cliente, llamando a sendConversationRequest');
        response = await sendConversationRequest(options);
        console.log('[Conversation Client] Respuesta recibida de sendConversationRequest');
      }
      
      if (debugMode) {
        if (typeof response === 'string') {
          console.log('[Conversation Client] Respuesta (string):', response.substring(0, 500) + '...');
        } else {
          console.log('[Conversation Client] Respuesta (objeto):', JSON.stringify(response).substring(0, 500) + '...');
        }
      }
      
      // Procesar la respuesta para extraer el contenido JSON si es necesario
      if (toJSON && response) {
        console.log('[Conversation Client] Procesando respuesta para extraer JSON');
        
        // Si la respuesta ya es un string, verificar si es JSON directamente
        if (typeof response === 'string') {
          console.log('[Conversation Client] Respuesta es un string, intentando parsear como JSON');
          try {
            const jsonContent = JSON.parse(response);
            console.log('[Conversation Client] String parseado como JSON correctamente');
            return jsonContent;
          } catch (parseError) {
            console.log('[Conversation Client] Error al parsear string como JSON, buscando JSON en el texto');
            
            // Buscar JSON en el texto (mejorado para manejar diferentes formatos)
            const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```|({[\s\S]*?})/);
            if (jsonMatch) {
              try {
                const jsonContent = JSON.parse(jsonMatch[1] || jsonMatch[2]);
                console.log('[Conversation Client] JSON encontrado en el texto');
                return jsonContent;
              } catch (matchError) {
                console.log('[Conversation Client] Error al parsear JSON encontrado, devolviendo el contenido original');
                // Si no podemos parsear el JSON, devolver el contenido original
                // para que el servicio de continuación pueda intentar repararlo
                return response;
              }
            } else {
              console.log('[Conversation Client] No se encontró JSON en el texto, devolviendo el contenido original');
              // Devolver el contenido original para que el servicio de continuación pueda intentar repararlo
              return response;
            }
          }
        }
        
        // Verificar si la respuesta tiene una estructura específica de la API
        if (response.choices && response.choices.length > 0) {
          console.log('[Conversation Client] Respuesta tiene estructura de choices');
          
          // Extraer el contenido del mensaje
          const messageContent = response.choices[0].message?.content;
          
          if (messageContent) {
            console.log('[Conversation Client] Contenido del mensaje encontrado');
            
            // Intentar parsear el contenido como JSON
            try {
              // Verificar si el contenido ya es un objeto
              if (typeof messageContent === 'object') {
                console.log('[Conversation Client] El contenido ya es un objeto');
                return messageContent;
              }
              
              // Intentar parsear el contenido como JSON
              const jsonContent = JSON.parse(messageContent);
              console.log('[Conversation Client] Contenido parseado como JSON');
              return jsonContent;
            } catch (parseError) {
              console.log('[Conversation Client] Error al parsear como JSON, buscando JSON en el texto');
              
              // Buscar JSON en el texto (mejorado para manejar diferentes formatos)
              const jsonMatch = messageContent.match(/```(?:json)?\s*([\s\S]*?)\s*```|({[\s\S]*?})/);
              if (jsonMatch) {
                try {
                  const jsonContent = JSON.parse(jsonMatch[1] || jsonMatch[2]);
                  console.log('[Conversation Client] JSON encontrado en el texto');
                  return jsonContent;
                } catch (matchError) {
                  console.log('[Conversation Client] Error al parsear JSON encontrado, devolviendo el contenido original');
                  // Si no podemos parsear el JSON, devolver el contenido original
                  // para que el servicio de continuación pueda intentar repararlo
                  return messageContent;
                }
              } else {
                console.log('[Conversation Client] No se encontró JSON en el texto, devolviendo el contenido original');
                // Devolver el contenido original para que el servicio de continuación pueda intentar repararlo
                return messageContent;
              }
            }
          }
        }
        
        // Si llegamos aquí, devolver la respuesta original
        console.log('[Conversation Client] No se pudo extraer JSON, devolviendo respuesta original');
      }
      
      return response;
    } catch (error: any) {
      console.error('[Conversation Client] Error en la solicitud:', error);
      
      // Si es un error de timeout, proporcionar un mensaje más claro
      if (error.message && error.message.includes('Timeout')) {
        console.error(`[Conversation Client] La solicitud excedió el timeout de ${timeout}ms`);
        throw new Error(`La solicitud excedió el timeout de ${timeout}ms. Intente aumentar el timeout o reducir la complejidad del análisis.`);
      }
      
      throw error;
    }
  } catch (error: any) {
    console.error('[Conversation Client] Error en analyzeWithConversationApi:', error);
    throw error;
  }
} 