import { NextRequest, NextResponse } from 'next/server';
import { getOpenRouterChatModel } from '@/lib/services/ai/openrouter';
import { processConversation } from './core';

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
