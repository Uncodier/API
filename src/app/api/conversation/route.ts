/**
 * @file conversation/route.ts
 * @description API endpoint para mantener conversaciones con modelos de IA
 * 
 * Este endpoint permite a los usuarios mantener conversaciones contextuales
 * con diferentes modelos de IA, con la opción de incluir información sobre
 * un sitio web específico para obtener respuestas más relevantes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createOpenRouterClient, getOpenRouterChatModel, isOpenRouterReasoningModel } from '@/lib/services/ai/openrouter';
import { getRequestOptions } from '@/lib/config/analyzer-config';
import { prepareImageForAPI } from '@/lib/utils/image-utils';
import { prepareAnalysisData } from '@/lib/utils/api-utils';
import { AnalyzeRequest } from '@/lib/types/analyzer-types';
import { isIncompleteJson, attemptJsonRepair, extractResponseContent, updateResponseContent } from '@/lib/services/continuation-service';

// Añadir almacén temporal para conversaciones
// Este objeto mantendrá el contexto de las conversaciones activas
const conversationStore: Record<string, {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | any;
  }>;
  lastUpdated: number;
  incompleteJson?: string;
  modelType?: 'anthropic' | 'openai' | 'gemini';
  modelId?: string;
  closed?: boolean; // Indica si la conversación está cerrada o requiere continuación
}> = {};

// Función para limpiar conversaciones antiguas
// Se ejecutará periódicamente para evitar fugas de memoria
const CONVERSATION_TIMEOUT = 30 * 60 * 1000; // 30 minutos
function cleanupOldConversations() {
  const now = Date.now();
  Object.keys(conversationStore).forEach(id => {
    if (now - conversationStore[id].lastUpdated > CONVERSATION_TIMEOUT) {
      console.log(`[Conversation Store] Eliminando conversación ${id} por inactividad`);
      delete conversationStore[id];
    }
  });
}

// Cleanup on requests, without a process-lifetime timer in serverless route modules.

/**
 * Procesa una solicitud de conversación con modelos de IA
 * Esta función puede ser utilizada internamente por otros servicios sin necesidad de hacer una solicitud HTTP
 * 
 * @param options Opciones para la conversación
 * @returns Respuesta del modelo de IA con metadatos, incluyendo:
 *   - _requestMetadata: Objeto con metadatos como timestamp, duración, tipo de modelo, etc.
 *   - _requestMetadata.closed: Booleano que indica si la conversación está cerrada (completa)
 *     o si requiere continuación (false, generalmente para JSON incompletos)
 */
export async function processConversation(options: {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | any;
  }>;
  modelType?: 'anthropic' | 'openai' | 'gemini';
  modelId?: string;
  includeScreenshot?: boolean;
  siteUrl?: string;
  responseFormat?: 'json' | 'text';
  timeout?: number;
  conversationId?: string; // Nuevo parámetro para ID de conversación
  isContinuation?: boolean; // Indica si es continuación de una respuesta incompleta
  userId?: string;
}): Promise<any> {
  cleanupOldConversations();
  
  const { 
    messages, 
    modelType = 'openai',
    modelId, 
    includeScreenshot = false, 
    siteUrl,
    responseFormat,
    timeout = 120000, // Aumentado a 120 segundos (2 minutos) por defecto
    conversationId = generateConversationId(options), // Usar una función para generar ID basado en sitio o usuario
    isContinuation = false,
    userId
  } = options;
  
  console.log(`[Conversation Service] Usando ID de conversación: ${conversationId}`);
  
  // Verificar si se solicita una respuesta en formato JSON
  const requestJsonResponse = responseFormat === 'json';
  console.log('[Conversation Service] JSON response requested:', requestJsonResponse);
  
  if (!messages || !Array.isArray(messages)) {
    console.log('[Conversation Service] Error: Se requiere un array de mensajes');
    throw new Error('Se requiere un array de mensajes');
  }
  
  // Gestionar el contexto de la conversación
  let enhancedMessages = [...messages];
  
  // Si hay una conversación existente con este ID, incorporar su contexto
  if (conversationStore[conversationId] && !isContinuation) {
    console.log(`[Conversation Service] Recuperando contexto de conversación existente: ${conversationId}`);
    // Mantener la última interacción del usuario y añadir el historial previo
    const lastUserMessage = enhancedMessages.find(m => m.role === 'user');
    if (lastUserMessage) {
      enhancedMessages = [
        ...conversationStore[conversationId].messages,
        lastUserMessage
      ];
      console.log(`[Conversation Service] Contexto recuperado con ${conversationStore[conversationId].messages.length} mensajes previos`);
    } else {
      enhancedMessages = conversationStore[conversationId].messages;
    }
  }
  
  // Si es una continuación para completar JSON, usar los mensajes existentes y añadir instrucción de continuación
  if (isContinuation && conversationStore[conversationId]?.incompleteJson) {
    console.log(`[Conversation Service] Continuando generación de JSON incompleto`);
    const incompleteJson = conversationStore[conversationId].incompleteJson;
    
    // Crear mensajes para la continuación
    enhancedMessages = [
      ...conversationStore[conversationId].messages,
      { 
        role: 'assistant', 
        content: incompleteJson 
      },
      { 
        role: 'user', 
        content: 'La respuesta JSON está incompleta. Por favor, continúa exactamente donde te quedaste sin repetir lo que ya has enviado. Completa el JSON y asegúrate de que sea válido.'
      }
    ];
  }
  
  const modelOptions = getRequestOptions(modelType, modelId).openrouter;
  const openrouter = createOpenRouterClient({ timeout });
  
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
        
        // The gateway requires image_url parts for every model vendor.
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
    const modelResponse = await openrouter.chat.completions.create({
      ...modelOptions,
      messages: enhancedMessages,
      ...(isOpenRouterReasoningModel(modelOptions.model) ? {} : { temperature: 0.7 }),
      stream: false
    }, { signal: controller.signal });
    
    // Registrar fin del análisis y calcular duración
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // en segundos
    console.log(`[Conversation Service] Request completed in ${duration.toFixed(2)} seconds`);
    
    // Limpiar el timeout
    clearTimeout(timeoutId);
    
    // Procesar la respuesta según el formato solicitado
    console.log('[Conversation Service] Processing response');
    
    // Si se solicitó una respuesta en formato JSON, verificar si la respuesta es un JSON válido
    if (requestJsonResponse) {
      console.log('[Conversation Service] Verificando si la respuesta es un JSON válido');
      
      // Extraer el contenido de la respuesta según el proveedor
      let content = extractResponseContent(modelResponse);
      if (isContinuation && conversationStore[conversationId]?.incompleteJson) {
        const combined = conversationStore[conversationId].incompleteJson + content;
        if (!isIncompleteJson(combined)) {
          content = combined;
          updateResponseContent(modelResponse, content);
          conversationStore[conversationId].closed = true;
          delete conversationStore[conversationId].incompleteJson;
        }
        if (!isIncompleteJson(content)) {
          conversationStore[conversationId].closed = true;
          delete conversationStore[conversationId].incompleteJson;
        }
      }
      
      // Verificar si la respuesta parece ser un JSON incompleto
      if (content && content.trim().startsWith('{') && isIncompleteJson(content)) {
        console.log('[Conversation Service] Detectada respuesta JSON incompleta, iniciando proceso de continuación');
        
        // Guardar el JSON incompleto en el almacén de conversaciones para continuaciones futuras
        if (!conversationStore[conversationId]) {
          conversationStore[conversationId] = {
            messages: enhancedMessages,
            lastUpdated: Date.now(),
            modelType,
            modelId
          };
        }
        conversationStore[conversationId].incompleteJson = content;
        conversationStore[conversationId].lastUpdated = Date.now();
        conversationStore[conversationId].closed = false; // Marcar la conversación como no cerrada
        
        // Intentar primero con el método de reparación rápida
        const repairedJson = attemptJsonRepair(content);
        if (repairedJson) {
          console.log('[Conversation Service] JSON reparado exitosamente sin usar IA');
          
          // Limpiar el JSON incompleto del almacén ya que ha sido reparado
          delete conversationStore[conversationId].incompleteJson;
          conversationStore[conversationId].closed = true; // Marcar la conversación como cerrada tras la reparación
          
          // Actualizar la respuesta con el JSON reparado
          const repairedJsonString = JSON.stringify(repairedJson);
          
          updateResponseContent(modelResponse, repairedJsonString);
        } else {
          console.log('[Conversation Service] No se pudo reparar el JSON, usando servicio de continuación');
          
          // Si es la primera vez (no es una continuación), intentar completar automáticamente
          if (!isContinuation) {
            // Usar un timeout extendido para la continuación
            const continuationTimeout = timeout * 1.5; // 50% más de tiempo para la continuación
            console.log(`[Conversation Service] Usando timeout extendido para continuación: ${continuationTimeout}ms`);
            
            try {
              // Llamar recursivamente a processConversation con la bandera de continuación
              console.log('[Conversation Service] Iniciando continuación automática');
              const continuationResult = await processConversation({
                messages: enhancedMessages,
                modelType,
                modelId: modelOptions.model,
                includeScreenshot,
                siteUrl,
                responseFormat,
                timeout: continuationTimeout,
                conversationId,
                isContinuation: true,
                userId
              });
              
              console.log('[Conversation Service] Continuación automática completada');
              
              // Si la continuación fue exitosa, usar su resultado
              if (!isIncompleteJson(extractResponseContent(continuationResult))) {
                console.log('[Conversation Service] Continuación exitosa, usando resultado');
                // Marcar la conversación como cerrada ya que la continuación fue exitosa
                if (conversationStore[conversationId]) {
                  conversationStore[conversationId].closed = true;
                  delete conversationStore[conversationId].incompleteJson;
                  conversationStore[conversationId].messages = [
                    ...enhancedMessages,
                    { role: 'assistant', content: extractResponseContent(continuationResult) },
                  ];
                }
                // Preserve the first billable generation alongside continuation metadata.
                continuationResult.continuation_generations = [
                  { id: modelResponse.id, provider: (modelResponse as any).provider,
                    model: modelResponse.model, usage: modelResponse.usage },
                  ...(continuationResult.continuation_generations || []),
                ];
                return continuationResult;
              }
            } catch (continuationError) {
              console.error('[Conversation Service] Error en continuación automática');
            }
          }
          
          // Si la continuación automática falló o es una continuación recursiva,
          // seguir con los métodos existentes
          // ... existing code ...
        }
      }
      
      console.log('[Conversation Service] Respuesta procesada para JSON');
    }
    
    // Actualizar o guardar el contexto de conversación si no es una continuación
    if (!isContinuation) {
      console.log(`[Conversation Service] Actualizando contexto de conversación: ${conversationId}`);
      // Extraer el contenido de la respuesta
      const assistantContent = extractResponseContent(modelResponse);
      
      // Crear o actualizar la entrada en el almacén de conversaciones
      const updatedMessages: Array<{
        role: 'system' | 'user' | 'assistant';
        content: string | any;
      }> = [
        ...enhancedMessages,
        {
          role: 'assistant',
          content: assistantContent
        }
      ];
      
      conversationStore[conversationId] = {
        messages: updatedMessages,
        lastUpdated: Date.now(),
        modelType,
        modelId,
        ...(conversationStore[conversationId]?.incompleteJson
          ? { incompleteJson: conversationStore[conversationId].incompleteJson } : {}),
        closed: !requestJsonResponse || (requestJsonResponse && !isIncompleteJson(assistantContent)) // Marcar como cerrada si no es JSON o si es JSON válido
      };
      
      console.log(`[Conversation Service] Conversación ${conversationId} actualizada con ${updatedMessages.length} mensajes`);
    }
    
    // Añadir metadatos de la solicitud e ID de conversación a la respuesta
    const responseWithMetadata = {
      ...modelResponse,
      _requestMetadata: {
        timestamp: new Date().toISOString(),
        duration: duration,
        modelType: modelType,
        modelId: modelOptions.model,
        gateway: 'openrouter',
        siteUrl: siteUrl,
        includeScreenshot: includeScreenshot,
        conversationId: conversationId,
        closed: conversationStore[conversationId]?.closed !== false // Valor predeterminado true si no está explícitamente como false
      }
    };
    
    return responseWithMetadata;
  } catch (apiError: any) {
    // Limpiar el timeout
    clearTimeout(timeoutId);
    
    console.error('[Conversation Service] OpenRouter request failed');
    
    // Marcar la conversación como cerrada en caso de error
    // Esto evita que se intente continuar con una conversación que ha fallado
    if (conversationStore[conversationId]) {
      conversationStore[conversationId].closed = true;
      delete conversationStore[conversationId].incompleteJson;
    }
    
    // Añadir metadatos incluso en caso de error
    const errorResponse = {
      error: 'OpenRouter request failed',
      _requestMetadata: {
        timestamp: new Date().toISOString(),
        modelType: modelType,
        modelId: modelId,
        siteUrl: siteUrl,
        includeScreenshot: includeScreenshot,
        conversationId: conversationId,
        closed: true // Cerrar la conversación en caso de error
      }
    };
    
    // En lugar de lanzar una excepción, devolvemos una respuesta con formato consistente
    // pero con información del error y marcada como cerrada
    return errorResponse;
  }
}

/**
 * Genera un ID de conversación basado en la URL del sitio o ID de usuario
 * Si no hay ninguno de los dos, se genera uno aleatorio
 */
function generateConversationId(options: {
  siteUrl?: string;
  userId?: string;
  modelType?: string;
}): string {
  const { siteUrl, userId, modelType } = options;
  const timestamp = Date.now();
  
  // Generar una base para el ID
  let baseId = '';
  
  if (siteUrl) {
    // Usar la URL del sitio como base, eliminando protocolo y caracteres especiales
    try {
      const url = new URL(siteUrl);
      baseId = url.hostname.replace(/[^a-zA-Z0-9]/g, '_');
    } catch (e) {
      // Si la URL no es válida, usar el string tal cual, limpiando caracteres especiales
      baseId = siteUrl.replace(/[^a-zA-Z0-9]/g, '_');
    }
  } else if (userId) {
    // Usar el ID de usuario si está disponible
    baseId = `user_${userId}`;
  } else {
    // Si no hay ni URL ni usuario, generar un ID aleatorio
    baseId = `rand_${Math.random().toString(36).substring(2, 7)}`;
  }
  
  // Añadir tipo de modelo para diferenciar entre proveedores
  const modelPrefix = modelType ? `${modelType.substring(0, 3)}_` : '';
  
  // Construir el ID final con un timestamp para hacerlo único
  return `conv_${modelPrefix}${baseId}_${timestamp}`;
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
 *   "responseFormat": "json", // Opcional: solicitar respuesta en formato JSON
 *   "conversationId": "conv_1234567890", // Opcional: ID para mantener contexto
 *   "userId": "user123" // Opcional: ID de usuario para generar conversationId
 * }
 * ```
 */
export async function POST(request: NextRequest) {
  console.log('[API:conversation] POST request received');
  try {
    console.log('[API:conversation] Parsing request body');
    const body = await request.json();
    
    const { 
      messages, 
      modelType = 'openai',
      modelId, 
      includeScreenshot = false, 
      siteUrl = body.url, // Usar url como fallback para siteUrl
      responseFormat,
      toJSON,
      timeout = 45000,
      conversationId,
      userId
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
        timeout,
        conversationId,
        userId
      });
      
      // Devolver la respuesta
       return NextResponse.json(result, { status: result.error ? 500 : 200 });
    } catch (error: any) {
      console.error('[API:conversation] Error processing conversation');
      // Crear una respuesta de error con el campo closed establecido a true
      // para evitar que el cliente intente continuar con una conversación fallida
      return NextResponse.json(
        { 
          error: 'Error al procesar la conversación de OpenRouter',
          _requestMetadata: {
            timestamp: new Date().toISOString(),
            conversationId: conversationId || 'unknown',
            closed: true // Marcar como cerrada en caso de error
          }
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('[API:conversation] Error parsing request');
    return NextResponse.json(
      { 
        error: 'Error al procesar la solicitud',
        _requestMetadata: {
          timestamp: new Date().toISOString(),
          closed: true // Marcar como cerrada en caso de error de parseo
        }
      },
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
        modelType: 'openai',
        modelId: getOpenRouterChatModel(),
        includeScreenshot: false,
        siteUrl: 'https://example.com',
        responseFormat: 'json', // Opcional: solicitar respuesta en formato JSON
        toJSON: true, // Alternativa a responseFormat: 'json'
        conversationId: 'conv_1234567890', // Opcional: ID para mantener contexto
        userId: 'user123' // Opcional: ID de usuario para generar conversationId
      },
      response: {
        _requestMetadata: {
          // ... otros metadatos ...
          conversationId: 'conv_1234567890',
          closed: true // Indica si la conversación está cerrada (completa) o requiere continuación
        }
      },
      features: {
        gateway: 'openrouter',
        html_processing: "Si se proporciona una URL en siteUrl, se capturará automáticamente el HTML del sitio y se incluirá como contexto en la conversación",
        screenshot: "Si includeScreenshot es true y se proporciona una URL en siteUrl, se capturará una imagen del sitio y se incluirá como contexto visual (solo compatible con modelos que soporten imágenes)",
        json_format: "Si responseFormat es 'json' o toJSON es true, se solicitará al modelo que estructure su respuesta como un objeto JSON y se devolverá formateado",
        conversation_context: "Si se proporciona un conversationId, se mantendrá el contexto de la conversación entre peticiones, útil para completar respuestas JSON incompletas",
        closed_status: "La respuesta incluye un campo 'closed' en _requestMetadata que indica si la conversación está cerrada (completa) o si requiere continuación para completar una respuesta JSON",
        providers: {
          anthropic: "Soporta HTML y capturas de pantalla como imágenes",
          openai: "Soporta HTML y capturas de pantalla como imágenes",
          gemini: "Soporta HTML e imágenes si el modelo seleccionado admite visión"
        }
      }
    },
    { status: 200 }
  );
} 