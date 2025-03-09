/**
 * @file conversation/route.ts
 * @description API endpoint para mantener conversaciones con modelos de IA
 * 
 * Este endpoint permite a los usuarios mantener conversaciones contextuales
 * con diferentes modelos de IA, con la opción de incluir información sobre
 * un sitio web específico para obtener respuestas más relevantes.
 */

import { NextRequest, NextResponse } from 'next/server';
import Portkey from 'portkey-ai';
import { getRequestOptions } from '@/lib/config/analyzer-config';
import { handleIncompleteJsonResponse, formatJsonResponse } from '@/lib/utils/api-utils';
import { fetchHtml } from '@/lib/utils/html-utils';
import { captureScreenshot, prepareImageForAPI } from '@/lib/utils/image-utils';

// Verificar claves disponibles
if (!process.env.PORTKEY_API_KEY) {
  console.warn('ADVERTENCIA: No se encontró PORTKEY_API_KEY en las variables de entorno');
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('ADVERTENCIA: No se encontró ANTHROPIC_API_KEY en las variables de entorno');
}
if (!process.env.AZURE_OPENAI_API_KEY) {
  console.warn('ADVERTENCIA: No se encontró AZURE_OPENAI_API_KEY en las variables de entorno');
}
if (!process.env.GEMINI_API_KEY) {
  console.warn('ADVERTENCIA: No se encontró GEMINI_API_KEY en las variables de entorno');
}

// Mapeo de proveedores a claves virtuales
const PROVIDER_TO_VIRTUAL_KEY: Record<string, string> = {
  'anthropic': process.env.ANTHROPIC_API_KEY || '',
  'openai': process.env.AZURE_OPENAI_API_KEY || '',
  'gemini': process.env.GEMINI_API_KEY || ''
};

/**
 * Maneja las solicitudes POST al endpoint de conversación
 * 
 * @param {NextRequest} request - La solicitud HTTP entrante
 * @returns {Promise<NextResponse>} Respuesta HTTP con el resultado de la conversación
 * 
 * @example
 * Ejemplo de cuerpo de solicitud:
 * ```json
 * {
 *   "messages": [
 *     { "role": "user", "content": "Hola, ¿puedes ayudarme con mi sitio web?" }
 *   ],
 *   "modelType": "anthropic",
 *   "modelId": "claude-3-5-sonnet-20240620",
 *   "includeScreenshot": false,
 *   "siteUrl": "https://example.com",
 *   "responseFormat": "json" // Opcional: solicitar respuesta en formato JSON
 * }
 * ```
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { 
      messages, 
      modelType = 'anthropic', 
      modelId, 
      includeScreenshot = false, 
      siteUrl,
      responseFormat
    } = body;
    
    // Verificar si se solicita una respuesta en formato JSON
    const requestJsonResponse = responseFormat === 'json';
    
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: 'Se requiere un array de mensajes' },
        { status: 400 }
      );
    }
    
    // Obtener la clave virtual para el proveedor seleccionado
    const virtualKey = PROVIDER_TO_VIRTUAL_KEY[modelType] || PROVIDER_TO_VIRTUAL_KEY['anthropic'];
    
    // Crear un cliente Portkey con la API key y virtual key específica
    const portkey = new Portkey({
      apiKey: process.env.PORTKEY_API_KEY || '',
      virtualKey: virtualKey,
      baseURL: 'https://api.portkey.ai/v1'
    });
    
    // Obtener opciones de solicitud
    const requestOptions = getRequestOptions(modelType, modelId);
    
    // Configurar opciones del modelo según el tipo
    let modelOptions;
    
    switch(modelType) {
      case 'anthropic':
        modelOptions = {
          model: requestOptions.anthropic.model,
          max_tokens: requestOptions.anthropic.max_tokens,
        };
        break;
      case 'openai':
        modelOptions = {
          model: requestOptions.openai.model,
          max_tokens: requestOptions.openai.max_tokens,
        };
        break;
      case 'gemini':
        modelOptions = {
          model: requestOptions.gemini.model,
          max_tokens: requestOptions.gemini.max_tokens,
        };
        break;
      default:
        modelOptions = {
          model: requestOptions.anthropic.model,
          max_tokens: requestOptions.anthropic.max_tokens,
        };
    }
    
    // Si se incluye la URL del sitio, añadir información contextual
    let enhancedMessages = [...messages];
    
    // Si se solicita una respuesta en formato JSON, añadir instrucciones específicas
    if (requestJsonResponse) {
      // Añadir instrucciones para formato JSON según el proveedor
      const jsonInstructions = `
Cuando se solicite una respuesta en formato JSON, sigue estas instrucciones:

1. Estructura tu respuesta como un objeto JSON válido.
2. Asegúrate de que todas las llaves y valores estén correctamente formateados.
3. Utiliza nombres de propiedades descriptivos y en camelCase.
4. Incluye metadatos relevantes cuando sea apropiado.
5. Para respuestas complejas, organiza la información en secciones lógicas.

Ejemplo de estructura JSON para diferentes tipos de respuestas:

Para análisis de sitios web:
{
  "analysis": {
    "title": "Título del análisis",
    "summary": "Resumen general del análisis",
    "sections": [
      {
        "name": "Diseño",
        "score": 8.5,
        "observations": ["Observación 1", "Observación 2"]
      },
      {
        "name": "Usabilidad",
        "score": 7.2,
        "observations": ["Observación 1", "Observación 2"]
      }
    ],
    "recommendations": [
      {
        "priority": "alta",
        "description": "Descripción de la recomendación",
        "impact": "Impacto esperado"
      }
    ]
  },
  "metadata": {
    "timestamp": "2023-08-15T14:30:00Z",
    "version": "1.0"
  }
}

Para respuestas de preguntas generales:
{
  "response": {
    "answer": "Respuesta principal a la pregunta",
    "details": [
      "Detalle adicional 1",
      "Detalle adicional 2"
    ],
    "sources": [
      {
        "name": "Nombre de la fuente",
        "url": "URL de la fuente (si aplica)"
      }
    ]
  },
  "metadata": {
    "confidence": 0.92,
    "timestamp": "2023-08-15T14:30:00Z"
  }
}

Asegúrate de que tu respuesta sea un JSON válido y completo.`;

      switch(modelType) {
        case 'anthropic':
          enhancedMessages.unshift({
            role: 'system',
            content: jsonInstructions
          });
          break;
        case 'openai':
          enhancedMessages.unshift({
            role: 'system',
            content: jsonInstructions
          });
          break;
        case 'gemini':
          // Gemini usa 'user' para el primer mensaje del sistema
          enhancedMessages.unshift({
            role: 'user',
            content: jsonInstructions
          });
          break;
      }
    }
    
    // Si se incluye la URL del sitio, añadir información contextual
    if (siteUrl) {
      console.log(`[Conversation API] Procesando sitio web: ${siteUrl}`);
      
      try {
        // Obtener HTML del sitio si se proporciona una URL
        let htmlContent = '';
        let screenshotBase64 = '';
        
        // Capturar HTML del sitio
        try {
          htmlContent = await fetchHtml(siteUrl, { timeout: 30000 });
          console.log(`[Conversation API] HTML obtenido (${htmlContent.length} bytes)`);
        } catch (htmlError) {
          console.warn(`[Conversation API] Error al obtener HTML: ${htmlError}`);
          htmlContent = '';
        }
        
        // Capturar screenshot si se solicita
        if (includeScreenshot) {
          try {
            screenshotBase64 = await captureScreenshot(siteUrl, { timeout: 30000 }) || '';
            console.log(`[Conversation API] Screenshot capturado (${screenshotBase64.length} bytes)`);
          } catch (screenshotError) {
            console.warn(`[Conversation API] Error al capturar screenshot: ${screenshotError}`);
            screenshotBase64 = '';
          }
        }
        
        // Añadir información contextual sobre el sitio según el proveedor
        switch(modelType) {
          case 'anthropic':
            enhancedMessages.unshift({
              role: 'system',
              content: `Esta conversación está relacionada con el análisis del sitio web: ${siteUrl}. Proporciona respuestas útiles y específicas sobre este sitio cuando sea relevante.`
            });
            break;
          case 'openai':
            enhancedMessages.unshift({
              role: 'system',
              content: `Esta conversación está relacionada con el análisis del sitio web: ${siteUrl}. Proporciona respuestas útiles y específicas sobre este sitio cuando sea relevante.`
            });
            break;
          case 'gemini':
            // Gemini usa 'user' para el primer mensaje del sistema
            enhancedMessages.unshift({
              role: 'user',
              content: `Esta conversación está relacionada con el análisis del sitio web: ${siteUrl}. Proporciona respuestas útiles y específicas sobre este sitio cuando sea relevante.`
            });
            break;
        }
        
        // Añadir HTML como contexto si está disponible
        if (htmlContent) {
          // Limitar el tamaño del HTML para evitar exceder los límites del contexto
          const maxHtmlLength = 50000; // Ajustar según los límites del modelo
          const truncatedHtml = htmlContent.length > maxHtmlLength 
            ? htmlContent.substring(0, maxHtmlLength) + '... [HTML truncado por tamaño]' 
            : htmlContent;
          
          // Añadir HTML según el formato del proveedor
          switch(modelType) {
            case 'anthropic':
              enhancedMessages.unshift({
                role: 'system',
                content: `HTML del sitio web (puede estar truncado):\n\`\`\`html\n${truncatedHtml}\n\`\`\``
              });
              break;
            case 'openai':
              // Para OpenAI, podemos usar tanto system como user para texto plano
              enhancedMessages.unshift({
                role: 'system',
                content: `HTML del sitio web (puede estar truncado):\n\`\`\`html\n${truncatedHtml}\n\`\`\``
              });
              break;
            case 'gemini':
              // Gemini usa 'user' para mensajes del sistema
              enhancedMessages.unshift({
                role: 'user',
                content: `HTML del sitio web (puede estar truncado):\n\`\`\`html\n${truncatedHtml}\n\`\`\``
              });
              break;
          }
        }
        
        // Añadir screenshot como imagen si está disponible
        if (screenshotBase64 && includeScreenshot) {
          // Preparar la imagen para el modelo
          const processedImage = prepareImageForAPI(screenshotBase64);
          
          if (processedImage) {
            // Añadir imagen según el formato del proveedor
            switch(modelType) {
              case 'anthropic':
                // Para Claude, añadir la imagen como un mensaje con contenido mixto
                enhancedMessages.unshift({
                  role: 'system',
                  content: [
                    {
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: 'image/png',
                        data: processedImage.replace(/^data:image\/[^;]+;base64,/, '')
                      }
                    },
                    {
                      type: 'text',
                      text: 'Captura de pantalla del sitio web para referencia visual.'
                    }
                  ]
                });
                break;
              case 'openai':
                // Para OpenAI, añadir la imagen como un mensaje con contenido mixto
                // IMPORTANTE: OpenAI solo permite imágenes en mensajes con role 'user'
                enhancedMessages.unshift({
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: 'Captura de pantalla del sitio web para referencia visual:'
                    },
                    {
                      type: 'image_url',
                      image_url: {
                        url: processedImage
                      }
                    }
                  ]
                });
                break;
              case 'gemini':
                // Para Gemini, añadir la imagen como texto (no soporta imágenes directamente en este contexto)
                enhancedMessages.unshift({
                  role: 'user',
                  content: 'Se ha capturado una imagen del sitio web, pero este modelo no puede procesarla directamente en este contexto.'
                });
                break;
            }
          }
        }
      } catch (siteProcessingError) {
        console.error(`[Conversation API] Error al procesar el sitio: ${siteProcessingError}`);
        // Continuar con la conversación sin el contexto del sitio
      }
    }
    
    // Realizar la solicitud a la API
    console.log(`[Conversation API] Enviando solicitud a ${modelType} ${modelId || 'default'} usando clave virtual ${virtualKey}...`);
    
    // Verificar y adaptar el formato de los mensajes según el proveedor
    const adaptedMessages = enhancedMessages.map(msg => {
      // Asegurarse de que el contenido tenga el formato correcto para cada proveedor
      if (typeof msg.content === 'string') {
        return msg;
      } else if (Array.isArray(msg.content)) {
        // Para contenido estructurado (como imágenes)
        switch(modelType) {
          case 'anthropic':
            // Claude acepta contenido estructurado
            return msg;
          case 'openai':
            // OpenAI acepta contenido estructurado pero solo en mensajes 'user'
            if (msg.role !== 'user' && msg.content.some((item: any) => item.type === 'image_url')) {
              console.warn('[Conversation API] OpenAI solo permite imágenes en mensajes con role "user". Cambiando role a "user".');
              return {
                ...msg,
                role: 'user'
              };
            }
            return msg;
          case 'gemini':
            // Gemini no acepta contenido estructurado, convertir a texto
            return {
              role: msg.role,
              content: 'Contenido multimedia no soportado por este modelo'
            };
          default:
            return msg;
        }
      }
      return msg;
    });
    
    // Registrar la estructura de los mensajes para depuración
    console.log(`[Conversation API] Estructura de mensajes adaptados para ${modelType}:`);
    adaptedMessages.forEach((msg, index) => {
      const contentType = typeof msg.content === 'string' ? 'texto' : 'estructurado';
      console.log(`[Conversation API] Mensaje ${index}: role=${msg.role}, tipo=${contentType}`);
    });
    
    try {
      const response = await portkey.chat.completions.create({
        messages: adaptedMessages,
        ...modelOptions
      });
      
      // Verificar si la respuesta contiene un JSON incompleto y manejarlo
      const processedResponse = await handleIncompleteJsonResponse(response, adaptedMessages, modelType, modelId);
      
      // Extraer el contenido de la respuesta según el proveedor
      let content = '';
      
      if (modelType === 'anthropic') {
        content = processedResponse.content?.[0]?.text || '';
      } else if (modelType === 'openai') {
        content = processedResponse.choices?.[0]?.message?.content || '';
      } else if (modelType === 'gemini') {
        content = processedResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
      }
      
      // Procesar la respuesta para formato JSON si se solicitó
      const formattedResponse = formatJsonResponse(content, requestJsonResponse);
      
      // Actualizar la respuesta con el contenido formateado
      if (modelType === 'anthropic') {
        processedResponse.content[0].text = formattedResponse.content;
      } else if (modelType === 'openai') {
        processedResponse.choices[0].message.content = formattedResponse.content;
      } else if (modelType === 'gemini') {
        processedResponse.candidates[0].content.parts[0].text = formattedResponse.content;
      }
      
      // Añadir metadatos de JSON a la respuesta
      return NextResponse.json({
        ...processedResponse,
        _metadata: {
          isJsonResponse: formattedResponse.isJsonResponse,
          extractedJson: formattedResponse.extractedJson,
          requestedJsonFormat: requestJsonResponse
        }
      });
    } catch (apiError: any) {
      console.error('[Conversation API] Error al llamar a la API:', apiError);
      
      // Proporcionar un mensaje de error más detallado
      let errorMessage = apiError.message || 'Error desconocido al procesar la solicitud';
      
      // Si hay información adicional en el error, incluirla
      if (apiError.response?.data) {
        errorMessage = JSON.stringify(apiError.response.data);
      }
      
      return NextResponse.json(
        { error: errorMessage },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('[Conversation API] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Error al procesar la solicitud' },
      { status: 500 }
    );
  }
}

/**
 * Maneja las solicitudes GET al endpoint de conversación
 * 
 * Proporciona información sobre cómo utilizar el endpoint
 * 
 * @param {NextRequest} request - La solicitud HTTP entrante
 * @returns {Promise<NextResponse>} Respuesta HTTP con información sobre el endpoint
 */
export async function GET(request: NextRequest) {
  return NextResponse.json(
    { 
      message: 'API de Conversación',
      usage: 'Envía una solicitud POST con un objeto JSON que contenga los mensajes, el tipo de modelo y el ID del modelo',
      example: {
        messages: [
          { role: 'user', content: 'Hola, ¿puedes ayudarme con mi sitio web?' }
        ],
        modelType: 'anthropic',
        modelId: 'claude-3-5-sonnet-20240620',
        includeScreenshot: false,
        siteUrl: 'https://example.com',
        responseFormat: 'json' // Opcional: solicitar respuesta en formato JSON
      },
      features: {
        html_processing: "Si se proporciona una URL en siteUrl, se capturará automáticamente el HTML del sitio y se incluirá como contexto en la conversación",
        screenshot: "Si includeScreenshot es true y se proporciona una URL en siteUrl, se capturará una imagen del sitio y se incluirá como contexto visual (solo compatible con modelos que soporten imágenes)",
        json_format: "Si responseFormat es 'json', se solicitará al modelo que estructure su respuesta como un objeto JSON y se devolverá formateado",
        providers: {
          anthropic: "Soporta HTML y capturas de pantalla como imágenes",
          openai: "Soporta HTML y capturas de pantalla como imágenes",
          gemini: "Soporta HTML pero no capturas de pantalla como imágenes"
        }
      }
    },
    { status: 200 }
  );
} 