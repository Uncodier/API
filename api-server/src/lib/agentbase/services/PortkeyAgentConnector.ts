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
          
          return this.processResponse(response, responseFormat);
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
      
    // Create a simple mock response
    if (responseFormat === 'json') {
      return {
        id: `msg_mock_${Date.now()}`,
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                response: "This is a mock response",
                query: lastUserMessage,
                timestamp: new Date().toISOString(),
                mock: true
              })
            }
          }
        ]
      };
    }
    
    return {
      id: `msg_mock_${Date.now()}`,
      choices: [
        {
          message: {
            role: 'assistant',
            content: `This is a mock text response to: "${lastUserMessage}"\nGenerated at ${new Date().toISOString()}\n(Note: This is a development mock)`
          }
        }
      ]
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
    // Get content from response
    const content = response?.choices?.[0]?.message?.content || '';
    
    if (responseFormat === 'json') {
      try {
        // Try to parse as JSON
        return JSON.parse(content);
      } catch (error) {
        // If parsing fails, try to extract JSON from text
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || 
                        content.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
          try {
            return JSON.parse(jsonMatch[1] || jsonMatch[0]);
          } catch {
            // Return the raw content if JSON extraction fails
            return content;
          }
        }
        
        return content;
      }
    }
    
    return content;
  }
} 