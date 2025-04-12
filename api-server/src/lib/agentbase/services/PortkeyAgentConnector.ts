/**
 * PortkeyAgentConnector for standardized LLM access
 */
import { PortkeyModelOptions, PortkeyConfig } from '../models/types';

export class PortkeyAgentConnector {
  private portkeyConfig: PortkeyConfig;
  private defaultOptions: Partial<PortkeyModelOptions>;
  
  constructor(config: PortkeyConfig, defaultOptions?: Partial<PortkeyModelOptions>) {
    this.portkeyConfig = config;
    this.defaultOptions = defaultOptions || {
      modelType: 'openai',
      maxTokens: 4096,
      temperature: 0.7,
      responseFormat: 'text'
    };
  }
  
  /**
   * Call an agent with messages using Portkey
   */
  async callAgent(
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string | any;
    }>,
    options?: Partial<PortkeyModelOptions>
  ): Promise<any> {
    try {
      // Merge default options with provided options
      const mergedOptions = { ...this.defaultOptions, ...options };
      const { modelType, modelId, maxTokens, temperature, topP, responseFormat } = mergedOptions;
      
      // Get virtual key for the selected provider
      const provider = modelType || this.defaultOptions.modelType || 'openai';
      const virtualKey = this.portkeyConfig.virtualKeys[provider] || '';
      
      // Check if we should use real API or mock responses
      const useMock = process.env.MOCK_API === 'true';
      
      if (useMock) {
        // Use mock response for testing
        return this.mockPortkeyResponse(messages, responseFormat);
      } else {
        // Use actual Portkey implementation
        try {
          // Import Portkey
          const Portkey = require('portkey-ai').default;
          
          console.log(`[PortkeyAgentConnector] Using Portkey with ${provider} model and virtual key: ${virtualKey.substring(0, 8)}...`);
          
          // Create Portkey client
          const portkey = new Portkey({
            apiKey: this.portkeyConfig.apiKey,
            virtualKey: virtualKey,
            baseURL: 'https://api.portkey.ai/v1'
          });
          
          // Get model options based on provider
          const modelOptions = this.getModelOptions(provider as any, modelId, maxTokens);
          
          // Add temperature if specified
          if (temperature !== undefined) {
            modelOptions.temperature = temperature;
          }
          
          // Add top_p if specified
          if (topP !== undefined) {
            modelOptions.top_p = topP;
          }
          
          // Make the API call
          const response = await portkey.chat.completions.create({
            messages: messages,
            ...modelOptions
          });
          
          // Procesar y añadir información de uso de tokens si no está presente
          const processed = this.processResponse(response, responseFormat);
          
          // Asegurarnos de que la información de tokens esté disponible
          if (!processed.usage && response.usage) {
            processed.usage = response.usage;
          } else if (!processed.usage) {
            // Si no hay información de uso, tratar de extraerla de diferentes lugares
            if (response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.usage) {
              processed.usage = response.choices[0].message.usage;
            } else {
              // Crear una estimación basada en la longitud de los mensajes y la respuesta
              const totalInputChars = messages.reduce((sum, msg) => sum + (typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length), 0);
              const outputChars = typeof processed === 'string' ? processed.length : JSON.stringify(processed).length;
              
              // Estimación rudimentaria: aproximadamente 4 caracteres por token
              processed.usage = {
                input_tokens: Math.ceil(totalInputChars / 4),
                output_tokens: Math.ceil(outputChars / 4),
                total_tokens: Math.ceil((totalInputChars + outputChars) / 4),
                estimated: true
              };
            }
          }
          
          console.log(`[PortkeyAgentConnector] Token usage - Input: ${processed.usage?.input_tokens || 'N/A'}, Output: ${processed.usage?.output_tokens || 'N/A'}`);
          
          return processed;
        } catch (error: any) {
          console.error(`[PortkeyAgentConnector] Portkey API call error:`, error);
          throw error;
        }
      }
      
    } catch (error: any) {
      console.error('[PortkeyAgentConnector] Error:', error);
      throw error;
    }
  }
  
  /**
   * Mock Portkey response for development/testing
   * In a real implementation, this would call the actual Portkey API
   */
  private mockPortkeyResponse(
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string | any;
    }>,
    responseFormat?: 'json' | 'text'
  ): any {
    // Get the last user message
    const lastUserMessage = messages
      .filter(msg => msg.role === 'user')
      .pop()?.content || '';
      
    // Estimar tokens basados en la longitud de los mensajes
    const totalInputChars = messages.reduce((sum, msg) => sum + (typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length), 0);
    
    // Crear una respuesta de ejemplo
    const responseMock = responseFormat === 'json' 
      ? JSON.stringify({
          response: "This is a mock response",
          query: lastUserMessage,
          timestamp: new Date().toISOString(),
          mock: true
        })
      : `This is a mock text response to: "${lastUserMessage}"\nGenerated at ${new Date().toISOString()}\n(Note: This is a development mock)`;
      
    // Estimación de tokens de salida
    const outputChars = responseMock.length;
    
    // Estimación rudimentaria: aproximadamente 4 caracteres por token
    const inputTokens = Math.ceil(totalInputChars / 4);
    const outputTokens = Math.ceil(outputChars / 4);
      
    // Create a simple mock response with usage information
    if (responseFormat === 'json') {
      return {
        id: `msg_mock_${Date.now()}`,
        choices: [
          {
            message: {
              role: 'assistant',
              content: responseMock
            }
          }
        ],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens
        }
      };
    }
    
    return {
      id: `msg_mock_${Date.now()}`,
      choices: [
        {
          message: {
            role: 'assistant',
            content: responseMock
          }
        }
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      }
    };
  }
  
  /**
   * Get model options based on provider and model ID
   */
  private getModelOptions(
    modelType: 'anthropic' | 'openai' | 'gemini', 
    modelId?: string,
    maxTokens?: number
  ): any {
    switch (modelType) {
      case 'anthropic':
        return {
          model: modelId || 'claude-3-5-sonnet-20240620',
          max_tokens: maxTokens || 4096
        };
      case 'openai':
        return {
          model: modelId || 'gpt-4o',
          max_tokens: maxTokens || 4096
        };
      case 'gemini':
        return {
          model: modelId || 'gemini-1.5-pro',
          max_tokens: maxTokens || 4096
        };
      default:
        return {
          model: modelId || 'gpt-4o',
          max_tokens: maxTokens || 4096
        };
    }
  }
  
  /**
   * Process the response based on format
   */
  private processResponse(response: any, responseFormat?: 'json' | 'text'): any {
    // Extraer información de tokens para preservarla
    const usage = response?.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    };
    
    // Get content from response
    const content = response?.choices?.[0]?.message?.content || '';
    
    let processedResult: any;
    
    if (responseFormat === 'json') {
      try {
        // Try to parse as JSON
        processedResult = JSON.parse(content);
      } catch (error) {
        // If parsing fails, try to extract JSON from text
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || 
                        content.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
          try {
            processedResult = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          } catch {
            // Return the raw content if JSON extraction fails
            processedResult = content;
          }
        } else {
          processedResult = content;
        }
      }
    } else {
      processedResult = content;
    }
    
    // Si el resultado es un objeto, añadir la información de tokens
    if (typeof processedResult === 'object' && processedResult !== null) {
      processedResult.usage = {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      };
      return processedResult;
    }
    
    // Si el resultado es una cadena, devolverlo como objeto con la información de tokens
    return {
      content: processedResult,
      usage: {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      }
    };
  }
}