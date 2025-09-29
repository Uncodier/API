import { NextRequest, NextResponse } from 'next/server';
import Portkey from 'portkey-ai';
import { getRequestOptions } from '@/lib/config/analyzer-config';
import { handleIncompleteJsonResponse } from '@/lib/utils/api-utils';

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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages, modelType = 'anthropic', modelId } = body;
    
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
    const requestOptions: any = getRequestOptions(modelType, modelId);
    
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
    
    // Realizar la solicitud a la API
    console.log(`[AI API] Enviando solicitud a ${modelType} ${modelId || 'default'} usando clave virtual ${virtualKey}...`);
    
    const response = await portkey.chat.completions.create({
      messages: messages,
      ...modelOptions
    });
    
    // Verificar si la respuesta contiene un JSON incompleto y manejarlo
    const processedResponse = await handleIncompleteJsonResponse(response, messages, modelType, modelId);
    
    return NextResponse.json(processedResponse);
  } catch (error: any) {
    console.error('[AI API] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Error al procesar la solicitud' },
      { status: 500 }
    );
  }
}

// Agregar método GET
/**
 * Endpoint GET para proporcionar información sobre la API de IA
 * @param request Solicitud HTTP
 * @returns Información sobre cómo usar la API de IA
 */
export async function GET(request: NextRequest) {
  return NextResponse.json(
    { 
      message: 'API de IA',
      usage: 'Envía una solicitud POST con un objeto JSON que contenga los mensajes, el tipo de modelo y el ID del modelo',
      example: {
        messages: [
          { role: 'user', content: 'Hola, ¿puedes ayudarme con mi sitio web?' }
        ],
        modelType: 'anthropic',
        modelId: 'claude-3-5-sonnet-20240620'
      },
      available_providers: ['anthropic', 'openai', 'gemini'],
      documentation: '/api/docs'
    },
    { status: 200 }
  );
} 