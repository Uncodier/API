/**
 * Opciones para una solicitud de conversación
 */
export interface ConversationOptions {
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
  conversationId?: string; // ID para mantener el contexto de la conversación
} 