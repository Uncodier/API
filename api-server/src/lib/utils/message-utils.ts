// Utilidades para la creación de mensajes para las APIs de IA
import { validateImageForVision } from './image-utils';
import { STRUCTURED_ANALYZER_SYSTEM_PROMPT } from '../config/analyzer-config';

/**
 * Crea un mensaje para la API de visión
 */
export function createVisionMessage(
  textContent: string,
  imageUrl: string | undefined,
  systemPrompt: string,
  provider: 'anthropic' | 'openai' | 'gemini' = 'anthropic'
): any[] {
  // Validar la imagen
  const hasValidImage = imageUrl && imageUrl.startsWith('data:image/');
  
  // Crear mensaje del sistema
  const systemMessage = {
    role: 'system',
    content: systemPrompt
  };
  
  // Si no hay imagen válida, crear un mensaje de texto simple
  if (!hasValidImage) {
    console.log('[createVisionMessage] No hay imagen válida, creando mensaje de texto simple');
    return [
      systemMessage,
      {
        role: 'user',
        content: textContent
      }
    ];
  }
  
  // Formato específico para cada proveedor
  switch (provider) {
    case 'anthropic':
      // Formato para Claude (Anthropic)
      return [
        systemMessage,
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: textContent
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: imageUrl.split(',')[1]
              }
            }
          ]
        }
      ];
      
    case 'gemini':
      // Formato para Gemini
      return [
        systemMessage,
        {
          role: 'user',
          parts: [
            {
              text: textContent
            },
            {
              inline_data: {
                mime_type: 'image/jpeg',
                data: imageUrl.split(',')[1]
              }
            }
          ]
        }
      ];
      
    case 'openai':
    default:
      // Formato para OpenAI
      return [
        systemMessage,
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: textContent
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl
              }
            }
          ]
        }
      ];
  }
}

/**
 * Genera un mensaje básico para la API
 */
export function createBasicMessage(content: string, systemPrompt: string): any[] {
  return [
    {
      role: 'system',
      content: systemPrompt
    },
    {
      role: 'user',
      content: content
    }
  ];
} 