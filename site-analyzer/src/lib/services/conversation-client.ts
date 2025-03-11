import { ConversationOptions } from '../types/conversation-types';
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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(`[Conversation Client] Timeout excedido (${options.timeout || 45000}ms)`);
    controller.abort();
  }, options.timeout || 45000);

  try {
    console.log('[Conversation Client] Preparando cuerpo de la solicitud');
    const requestBody = {
      messages: options.messages,
      modelType: options.modelType,
      modelId: options.modelId,
      includeScreenshot: options.includeScreenshot,
      siteUrl: options.siteUrl,
      responseFormat: options.responseFormat
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
      
      const responseText = await response.text();
      console.log(`[Conversation Client] Respuesta recibida (primeros 100 caracteres): ${responseText.substring(0, 100)}...`);
      
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
          includeScreenshot: options.includeScreenshot
        };
        
        return data;
      } catch (parseError) {
        console.error(`[Conversation Client] Error al analizar respuesta como JSON:`, parseError);
        console.error(`[Conversation Client] Primeros 200 caracteres de la respuesta:`, responseText.substring(0, 200));
        throw new Error(`Error al analizar respuesta como JSON. La respuesta no es un JSON válido: ${responseText.substring(0, 100)}...`);
      }
    } catch (fetchError: any) {
      console.error(`[Conversation Client] Error al llamar a la API de conversación:`, fetchError);
      
      // Propagar el error para que sea manejado por el llamador
      throw new Error(`Error al llamar a la API de conversación: ${fetchError.message || 'Error desconocido'}`);
    }
  } catch (error: any) {
    console.error(`[Conversation Client] Error en solicitud:`, error);
    if (error.name === 'AbortError') {
      throw new Error(`Timeout excedido (${options.timeout || 45000}ms)`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function analyzeWithConversationApi(
  prompt: string,
  modelType: 'anthropic' | 'openai' | 'gemini',
  modelId: string,
  siteUrl: string,
  includeScreenshot: boolean = true,
  timeout: number = 45000,
  debugMode: boolean = false,
  toJSON: boolean = true
): Promise<any> {
  console.log('[Conversation Client] analyzeWithConversationApi - Iniciando análisis con parámetros:', {
    modelType,
    modelId,
    siteUrl,
    includeScreenshot,
    timeout,
    debugMode,
    toJSON,
    promptLength: prompt?.length,
    isServer: typeof window === 'undefined',
    baseUrl: typeof window === 'undefined' ? (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000') : window.location.origin
  });

  if (!prompt) {
    console.error('[Conversation Client] Error: Se requiere un prompt');
    throw new Error('Se requiere un prompt para el análisis');
  }

  if (!modelType) {
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
      modelType,
      modelId,
      siteUrl,
      includeScreenshot,
      responseFormat: toJSON ? 'json' : 'text',
      timeout
    };

    console.log('[Conversation Client] Opciones preparadas:', JSON.stringify({
      modelType: options.modelType,
      modelId: options.modelId,
      siteUrl: options.siteUrl,
      includeScreenshot: options.includeScreenshot,
      responseFormat: options.responseFormat,
      timeout: options.timeout,
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
        response = await processConversation(options);
        console.log('[Conversation Client] Respuesta recibida de processConversation');
      } else {
        // En el cliente, usar la API normal
        console.log('[Conversation Client] Ejecutando en cliente, llamando a sendConversationRequest');
        response = await sendConversationRequest(options);
        console.log('[Conversation Client] Respuesta recibida de sendConversationRequest');
      }
      
      if (debugMode) {
        console.log('[Conversation Client] Respuesta completa:', JSON.stringify(response));
      }
      
      // Procesar la respuesta para extraer el contenido JSON si es necesario
      if (toJSON && response) {
        console.log('[Conversation Client] Procesando respuesta para extraer JSON');
        
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
              
              // Buscar JSON en el texto
              const jsonMatch = messageContent.match(/```(?:json)?\s*({[\s\S]*?})\s*```|({[\s\S]*?})/);
              if (jsonMatch) {
                try {
                  const jsonContent = JSON.parse(jsonMatch[1] || jsonMatch[2]);
                  console.log('[Conversation Client] JSON encontrado en el texto');
                  return jsonContent;
                } catch (matchError) {
                  console.log('[Conversation Client] Error al parsear JSON encontrado');
                }
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
      throw error;
    }
  } catch (error: any) {
    console.error('[Conversation Client] Error en analyzeWithConversationApi:', error);
    throw error;
  }
} 