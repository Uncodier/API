/**
 * @file conversation/route.ts
 * @description API endpoint para mantener conversaciones con modelos de IA
 * 
 * Este endpoint permite a los usuarios mantener conversaciones contextuales
 * con diferentes modelos de IA, con la opción de incluir información sobre
 * un sitio web específico para obtener respuestas más relevantes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Portkey } from 'portkey-ai';
import { getRequestOptions } from '@/lib/config/analyzer-config';
import { handleIncompleteJsonResponse, formatJsonResponse } from '@/lib/utils/api-utils';
import { fetchHtml } from '@/lib/utils/html-utils';
import { captureScreenshot, prepareImageForAPI } from '@/lib/utils/image-utils';
import { prepareAnalysisData } from '@/lib/utils/api-utils';
import { AnalyzeRequest } from '@/lib/types/analyzer-types';

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
 * Procesa una solicitud de conversación con modelos de IA
 * Esta función puede ser utilizada internamente por otros servicios sin necesidad de hacer una solicitud HTTP
 * 
 * @param options Opciones para la conversación
 * @returns Respuesta del modelo de IA
 */
export async function processConversation(options: {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | any;
  }>;
  modelType: 'anthropic' | 'openai' | 'gemini';
  modelId: string;
  includeScreenshot?: boolean;
  siteUrl?: string;
  responseFormat?: 'json' | 'text';
  timeout?: number;
}) {
  console.log('[Conversation Service] Iniciando procesamiento con opciones:', JSON.stringify({
    modelType: options.modelType,
    modelId: options.modelId,
    includeScreenshot: options.includeScreenshot,
    siteUrl: options.siteUrl,
    responseFormat: options.responseFormat,
    messagesCount: options.messages?.length,
    timeout: options.timeout
  }));
  
  const { 
    messages, 
    modelType = 'anthropic', 
    modelId, 
    includeScreenshot = false, 
    siteUrl,
    responseFormat,
    timeout = 45000
  } = options;
  
  // Verificar si se solicita una respuesta en formato JSON
  const requestJsonResponse = responseFormat === 'json';
  console.log('[Conversation Service] JSON response requested:', requestJsonResponse);
  
  if (!messages || !Array.isArray(messages)) {
    console.log('[Conversation Service] Error: Se requiere un array de mensajes');
    throw new Error('Se requiere un array de mensajes');
  }
  
  // Obtener la clave virtual para el proveedor seleccionado
  const virtualKey = PROVIDER_TO_VIRTUAL_KEY[modelType] || PROVIDER_TO_VIRTUAL_KEY['anthropic'];
  console.log('[Conversation Service] Using provider:', modelType);
  console.log('[Conversation Service] Virtual key available:', !!virtualKey);
  
  // Crear un cliente Portkey con la API key y virtual key específica
  console.log('[Conversation Service] Creating Portkey client');
  const portkey = new Portkey({
    apiKey: process.env.PORTKEY_API_KEY || '',
    virtualKey: virtualKey,
    baseURL: 'https://api.portkey.ai/v1'
  });
  console.log('[Conversation Service] Portkey client created');
  
  // Obtener opciones de solicitud
  console.log('[Conversation Service] Getting request options for model:', modelType, modelId);
  const requestOptions = getRequestOptions(modelType, modelId);
  console.log('[Conversation Service] Request options obtained');
  
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
  console.log('[Conversation Service] Model options configured:', JSON.stringify(modelOptions));
  
  // Si se incluye la URL del sitio, añadir información contextual
  let enhancedMessages = [...messages];
  
  // Si se solicita una respuesta en formato JSON, añadir instrucciones específicas
  if (requestJsonResponse) {
    console.log('[Conversation Service] Adding JSON format instructions');
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
    console.log('[Conversation Service] Site URL provided, adding context');
    
    // Crear una solicitud de análisis para obtener datos del sitio
    const analyzeRequest: AnalyzeRequest = {
      url: siteUrl,
      options: {
        includeScreenshot,
        timeout,
        provider: modelType,
        modelId
      }
    };
    
    console.log(`[Conversation Service] Configuración de analyzeRequest:`, {
      url: analyzeRequest.url,
      timeout: analyzeRequest.options?.timeout,
      includeScreenshot: analyzeRequest.options?.includeScreenshot,
      provider: analyzeRequest.options?.provider,
      modelId: analyzeRequest.options?.modelId
    });
    
    // Utilizar la función prepareAnalysisData para obtener HTML y screenshot de manera consistente
    console.log(`[Conversation Service] Obteniendo datos del sitio con prepareAnalysisData`);
    const analysisData = await prepareAnalysisData(analyzeRequest);
    console.log(`[Conversation Service] Datos del sitio obtenidos`);
    
    // Añadir HTML al contexto si está disponible
    if (analysisData.htmlContent) {
      console.log(`[Conversation Service] Añadiendo HTML al contexto (${analysisData.htmlContent.length} bytes)`);
      enhancedMessages.unshift({
        role: 'user',
        content: `Aquí está el HTML del sitio ${siteUrl} para tu análisis:\n\n${analysisData.htmlContent}`
      });
    }
    
    // Añadir screenshot al contexto si está disponible y se solicitó
    if (includeScreenshot && analysisData.screenshotData) {
      console.log(`[Conversation Service] Añadiendo screenshot al contexto`);
      
      // Preparar la imagen para la API según el proveedor
      const imageData = await prepareImageForAPI(analysisData.screenshotData);
      
      if (imageData) {
        console.log(`[Conversation Service] Imagen preparada para ${modelType}`);
        
        switch (modelType) {
          case 'anthropic':
            enhancedMessages.unshift({
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: imageData
                  }
                },
                {
                  type: 'text',
                  text: `Aquí hay una captura de pantalla del sitio ${siteUrl} para tu análisis.`
                }
              ]
            });
            break;
          case 'openai':
            enhancedMessages.unshift({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Aquí hay una captura de pantalla del sitio ${siteUrl} para tu análisis.`
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageData.startsWith('data:image/') ? imageData : `data:image/png;base64,${imageData}`
                  }
                }
              ]
            });
            break;
          case 'gemini':
            enhancedMessages.unshift({
              role: 'user',
              content: `Aquí hay una captura de pantalla del sitio ${siteUrl} para tu análisis: [IMAGE: ${imageData.startsWith('data:image/') ? imageData : `data:image/png;base64,${imageData}`}]`
            });
            break;
        }
      }
    }
  }
  
  // Configurar el controlador de tiempo de espera
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(`[Conversation Service] Timeout excedido (${timeout}ms)`);
    controller.abort();
  }, timeout);
  
  try {
    // Registrar inicio del análisis con timestamp para medir duración
    const startTime = Date.now();
    console.log(`[Conversation Service] Iniciando solicitud a las ${new Date(startTime).toISOString()}`);
    
    // Realizar la solicitud a la API del modelo
    console.log('[Conversation Service] Sending request to model API');
    const result = await portkey.chat.completions.create({
      ...modelOptions,
      messages: enhancedMessages,
      temperature: 0.7,
      stream: false
    });
    
    // Registrar fin del análisis y calcular duración
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // en segundos
    console.log(`[Conversation Service] Request completed in ${duration.toFixed(2)} seconds`);
    
    // Limpiar el timeout
    clearTimeout(timeoutId);
    
    // Procesar la respuesta según el formato solicitado
    console.log('[Conversation Service] Processing response');
    
    // Añadir metadatos de la solicitud
    const responseWithMetadata = {
      ...result,
      _requestMetadata: {
        timestamp: new Date().toISOString(),
        duration: duration,
        modelType: modelType,
        modelId: modelId,
        siteUrl: siteUrl,
        includeScreenshot: includeScreenshot
      }
    };
    
    return responseWithMetadata;
  } catch (apiError: any) {
    // Limpiar el timeout
    clearTimeout(timeoutId);
    
    console.error('[Conversation Service] Error calling model API:', apiError);
    throw new Error(`Error calling model API: ${apiError.message || 'Unknown error'}`);
  }
}

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
  console.log('[API:conversation] POST request received');
  try {
    console.log('[API:conversation] Parsing request body');
    const body = await request.json();
    
    // Log completo del body para depuración
    console.log('[API:conversation] Request body completo:', JSON.stringify(body));
    
    console.log('[API:conversation] Request body parsed:', JSON.stringify({
      modelType: body.modelType,
      modelId: body.modelId,
      includeScreenshot: body.includeScreenshot,
      siteUrl: body.siteUrl,
      url: body.url, // Añadir log para url
      responseFormat: body.responseFormat,
      toJSON: body.toJSON, // Añadir log para toJSON
      messagesCount: body.messages?.length
    }));
    
    const { 
      messages, 
      modelType = 'anthropic', 
      modelId, 
      includeScreenshot = false, 
      siteUrl = body.url, // Usar url como fallback para siteUrl
      responseFormat,
      toJSON,
      timeout = 45000
    } = body;
    
    try {
      // Usar la función processConversation para procesar la solicitud
      const result = await processConversation({
        messages,
        modelType,
        modelId,
        includeScreenshot,
        siteUrl,
        // Si responseFormat no está definido pero toJSON sí, usar toJSON para determinar el formato
        responseFormat: responseFormat || (toJSON !== undefined ? (toJSON ? 'json' : 'text') : undefined),
        timeout
      });
      
      // Devolver la respuesta
      return NextResponse.json(result);
    } catch (error: any) {
      console.error('[API:conversation] Error processing conversation:', error);
      return NextResponse.json(
        { error: error.message || 'Error al procesar la conversación' },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('[API:conversation] Error parsing request:', error);
    return NextResponse.json(
      { error: 'Error al procesar la solicitud' },
      { status: 400 }
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
        responseFormat: 'json', // Opcional: solicitar respuesta en formato JSON
        toJSON: true // Alternativa a responseFormat: 'json'
      },
      features: {
        html_processing: "Si se proporciona una URL en siteUrl, se capturará automáticamente el HTML del sitio y se incluirá como contexto en la conversación",
        screenshot: "Si includeScreenshot es true y se proporciona una URL en siteUrl, se capturará una imagen del sitio y se incluirá como contexto visual (solo compatible con modelos que soporten imágenes)",
        json_format: "Si responseFormat es 'json' o toJSON es true, se solicitará al modelo que estructure su respuesta como un objeto JSON y se devolverá formateado",
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