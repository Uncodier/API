/**
 * AIGatewayService - Vercel AI Gateway fallback service
 * Provides a reliable fallback when Portkey fails
 */
import { generateText, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

export interface AIGatewayOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stream?: boolean;
  streamOptions?: {
    includeUsage?: boolean;
  };
}

export interface AIGatewayResponse {
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  modelInfo: {
    model: string;
    provider: string;
  };
  stream?: any;
  isStream?: boolean;
}

export class AIGatewayService {
  private gatewayUrl: string;
  private apiKey: string;
  
  constructor() {
    this.gatewayUrl = process.env.VERCEL_AI_GATEWAY || '';
    this.apiKey = process.env.VERCEL_AI_GATEWAY_API_KEY || '';
    
    if (!this.gatewayUrl) {
      console.warn('[AIGatewayService] VERCEL_AI_GATEWAY no está configurado');
    }
    
    if (!this.apiKey) {
      console.warn('[AIGatewayService] VERCEL_AI_GATEWAY_API_KEY no está configurado');
    }
  }

  /**
   * Call AI Gateway with messages
   */
  async callAgent(
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>,
    options: AIGatewayOptions
  ): Promise<AIGatewayResponse> {
    if (!this.gatewayUrl) {
      throw new Error('VERCEL_AI_GATEWAY no está configurado');
    }
    
    if (!this.apiKey) {
      throw new Error('VERCEL_AI_GATEWAY_API_KEY no está configurado');
    }

    const { model, maxTokens, temperature, topP, stream, streamOptions } = options;
    
    console.log(`[AIGatewayService] Llamando AI Gateway con modelo ${model}`);
    
    try {
      const startTime = Date.now();
      
      // Configure the OpenAI provider with AI Gateway
      const aiModel = openai(model, {
        baseURL: this.gatewayUrl,
        apiKey: this.apiKey,
      });
      
      const modelConfig = {
        model: aiModel,
        messages,
        maxTokens: maxTokens || 4096,
        temperature: temperature || 0.7,
        topP: topP,
      };
      
      if (stream) {
        console.log(`[AIGatewayService] Ejecutando en modo streaming`);
        
        const result = streamText(modelConfig);
        
        const duration = Date.now() - startTime;
        console.log(`[AIGatewayService] Stream iniciado en ${duration}ms`);
        
        return {
          content: '',
          stream: result.textStream,
          isStream: true,
          modelInfo: {
            model,
            provider: 'ai-gateway'
          }
        };
      } else {
        console.log(`[AIGatewayService] Ejecutando en modo estándar`);
        
        const result = await generateText(modelConfig);
        
        const duration = Date.now() - startTime;
        console.log(`[AIGatewayService] Respuesta recibida en ${duration}ms con ${result.text.length} caracteres`);
        
        return {
          content: result.text,
          usage: result.usage ? {
            prompt_tokens: result.usage.promptTokens,
            completion_tokens: result.usage.completionTokens,
            total_tokens: result.usage.totalTokens
          } : {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
          },
          modelInfo: {
            model,
            provider: 'ai-gateway'
          }
        };
      }
    } catch (error: any) {
      console.error(`[AIGatewayService] Error calling AI Gateway:`, error.message);
      throw new Error(`AI Gateway error: ${error.message}`);
    }
  }

  /**
   * Check if AI Gateway is available
   */
  isAvailable(): boolean {
    return !!(this.gatewayUrl && this.apiKey);
  }

  /**
   * Get gateway configuration info
   */
  getInfo(): { gatewayUrl: string; apiKey: string; available: boolean } {
    return {
      gatewayUrl: this.gatewayUrl ? `${this.gatewayUrl.substring(0, 30)}...` : 'Not configured',
      apiKey: this.apiKey ? `${this.apiKey.substring(0, 8)}...` : 'Not configured',
      available: this.isAvailable()
    };
  }
}
