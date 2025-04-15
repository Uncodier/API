/**
 * PortkeyConnector for standardized LLM access
 */
import { PortkeyModelOptions, PortkeyConfig } from '../models/types';
import Portkey from 'portkey-ai';

export class PortkeyConnector {
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
   * Call an LLM with messages using Portkey
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
      
      console.log(`[PortkeyConnector] Using Portkey with ${provider} model and virtual key: ${virtualKey.substring(0, 5)}...`);
      
      // Create Portkey client using direct import - using any type to avoid typing issues
      const portkey: any = new Portkey({
        apiKey: this.portkeyConfig.apiKey,
        virtualKey,
        baseURL: this.portkeyConfig.baseURL || 'https://api.portkey.ai/v1'
      });
      
      // Determine model options based on provider
      const modelOptions: any = {
        model: '',
        max_tokens: maxTokens || 4096
      };
      
      // Set model ID based on provider
      if (modelType === 'openai') {
        modelOptions.model = modelId || 'gpt-4o';
      } else if (modelType === 'anthropic') {
        modelOptions.model = modelId || 'claude-3-5-sonnet-20240620';
      } else if (modelType === 'gemini') {
        modelOptions.model = modelId || 'gemini-1.5-flash';
        
        // Gemini uses different parameter names
        modelOptions.maxOutputTokens = modelOptions.max_tokens;
        delete modelOptions.max_tokens;
      }
      
      // Add response format if specified
      if (responseFormat === 'json') {
        if (modelType === 'anthropic') {
          modelOptions.response_format = { type: 'json' };
        } else if (modelType === 'openai') {
          modelOptions.response_format = { type: 'json_object' };
        }
      }
      
      // Set temperature if provided
      if (temperature !== undefined) {
        modelOptions.temperature = temperature;
      }
      
      // Set top_p if provided
      if (topP !== undefined) {
        modelOptions.top_p = topP;
      }
      
      // Guardar el modelo y provider que realmente se está usando
      const usedModel = modelOptions.model || 'default';
      console.log(`[PortkeyConnector] Calling ${provider} with model ${usedModel}`);
      
      // Log the system messages for debugging
      const systemMessages = messages.filter(msg => msg.role === 'system');
      if (systemMessages.length > 0) {
        console.log(`[PortkeyConnector] Sending ${systemMessages.length} system messages:`);
        systemMessages.forEach((msg, index) => {
          console.log(`[PortkeyConnector] System message #${index + 1}: ${msg.content.substring(0, 200)}...`);
        });
      } else {
        console.log(`[PortkeyConnector] WARNING: No system messages being sent! This may affect agent identity.`);
      }
      
      // Log all messages in detail for debugging
      console.log(`[PortkeyConnector] Sending total of ${messages.length} messages to LLM:`);
      messages.forEach((msg, index) => {
        console.log(`[PortkeyConnector] Message #${index + 1} (${msg.role}): ${typeof msg.content === 'string' ? msg.content.substring(0, 100) + '...' : JSON.stringify(msg.content).substring(0, 100) + '...'}`);
      });
      
      // Execute the appropriate API call using portkey.chat.completions.create
      // This works for both OpenAI and Anthropic
      let response;
      let content;
      let usage;
      
      try {
        if (modelType === 'gemini') {
          // Gemini requires special format
          response = await portkey.gemini.generateContent({
            contents: messages.map(msg => ({
              role: msg.role === 'system' ? 'user' : msg.role,
              parts: [{ text: msg.content }]
            })),
            ...modelOptions
          });
          
          // Extract content and usage from Gemini response
          content = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
          usage = {
            prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
            completion_tokens: response.usageMetadata?.candidatesTokenCount || 0
          };
        } else {
          // Use unified chat completions API for OpenAI and Anthropic
          response = await portkey.chat.completions.create({
            messages,
            ...modelOptions
          });
          
          // Extract content and usage based on model type
          if (modelType === 'anthropic') {
            content = response.content?.[0]?.text || '';
          } else {
            // Default to OpenAI format
            content = response.choices?.[0]?.message?.content || '';
          }
          
          usage = response.usage;
        }
        
        // Return standardized response format with model information
        return {
          content,
          usage,
          modelInfo: {
            model: usedModel,
            provider: provider
          }
        };
      } catch (apiCallError: any) {
        console.error('[PortkeyConnector] Error calling provider API:', apiCallError);
        throw new Error(`Error calling ${provider} API: ${apiCallError.message}`);
      }
    } catch (error: any) {
      console.error('[PortkeyConnector] API call error:', error.message);
      
      // Return simplified error
      return {
        content: `Error calling LLM: ${error.message}`,
        error: error.message
      };
    }
  }
}