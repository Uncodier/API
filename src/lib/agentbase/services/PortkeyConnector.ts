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
      responseFormat: 'text',
      stream: true,
      streamOptions: {
        includeUsage: true
      }
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
      const { modelType, modelId, maxTokens, temperature, topP, responseFormat, stream, streamOptions } = mergedOptions;
      
      // Get virtual key for the selected provider
      const provider = modelType || this.defaultOptions.modelType || 'openai';
      const virtualKey = this.portkeyConfig.virtualKeys[provider] || '';
      
      console.log(`[PortkeyConnector] Using Portkey with ${provider} model and virtual key: ${virtualKey.substring(0, 5)}...`);
      
      // Create Portkey client using direct import - using any type to avoid typing issues
      // Configurar timeouts más generosos para evitar UND_ERR_BODY_TIMEOUT
      const portkey: any = new Portkey({
        apiKey: this.portkeyConfig.apiKey,
        virtualKey,
        baseURL: this.portkeyConfig.baseURL || 'https://api.portkey.ai/v1',
        // Configuraciones de timeout para evitar body timeouts
        timeout: 10 * 60 * 1000, // 10 minutos para requests largos
        bodyTimeout: 10 * 60 * 1000, // 10 minutos para recibir el body completo
        headersTimeout: 60 * 1000, // 1 minuto para headers
        connectTimeout: 30 * 1000 // 30 segundos para establecer conexión
      });
      
      // Determine model options based on provider
      const modelOptions: any = {
        model: '',
        max_tokens: maxTokens || 4096
      };
      
      // Set model ID based on provider
      if (modelType === 'openai') {
        modelOptions.model = modelId || 'gpt-4.1-nano';
        
        // Handle gpt-5 models specific parameters
        if (modelId === 'gpt-5-mini' || modelId === 'gpt-5' || modelId === 'gpt-5.1') {
          // Set appropriate max tokens based on model
          let maxCompletionTokens = modelOptions.max_tokens;
          if (modelId === 'gpt-5') {
            // gpt-5 has a 16k limit
            maxCompletionTokens = Math.min(maxCompletionTokens || 4096, 16384);
          }
          
          modelOptions.max_completion_tokens = maxCompletionTokens;
          delete modelOptions.max_tokens;
          console.log(`[PortkeyConnector] Using max_completion_tokens for ${modelId}: ${modelOptions.max_completion_tokens}`);
        }
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
      
      // Set temperature if provided (but skip for gpt-5 models which only support default value of 1)
      if (temperature !== undefined) {
        const isGpt5Model = modelType === 'openai' && (modelId === 'gpt-5' || modelId === 'gpt-5-mini' || modelId === 'gpt-5.1');
        if (!isGpt5Model) {
          modelOptions.temperature = temperature;
        } else {
          console.log(`[PortkeyConnector] Skipping temperature parameter for ${modelId} (only supports default value of 1)`);
        }
      }
      
      // Set top_p if provided
      if (topP !== undefined) {
        modelOptions.top_p = topP;
      }
      
      // Set streaming options if enabled
      if (stream === true) {
        modelOptions.stream = true;
        
        // Add stream options if provided
        if (streamOptions) {
          modelOptions.stream_options = {
            include_usage: streamOptions.includeUsage || false
          };
        }

        console.log(`[PortkeyConnector] Streaming enabled for this request`);
      }
      
      // Guardar el modelo y provider que realmente se está usando
      const usedModel = modelOptions.model || 'default';
      console.log(`[PortkeyConnector] Calling ${provider} with model ${usedModel}`);
      
      // Log the system messages for debugging
      const systemMessages = messages.filter(msg => msg.role === 'system');
      if (systemMessages.length > 0) {
        console.log(`[PortkeyConnector] Sending ${systemMessages.length} system messages:`);
        systemMessages.forEach((msg, index) => {
          const contentLength = typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length;
          console.log(`[PortkeyConnector] System message #${index + 1}: ${typeof msg.content === 'string' ? msg.content.substring(0, 100) : JSON.stringify(msg.content).substring(0, 100)}... (${contentLength} caracteres)`);
          
          // Verificar contenido del mensaje
          if (typeof msg.content === 'string' && contentLength < 10) {
            console.error(`[PortkeyConnector] ⚠️ ADVERTENCIA: System message #${index + 1} es muy corto (${contentLength} caracteres)`);
          }
        });
      } else {
        // No se permite operar sin mensaje del sistema
        const errorMsg = `[PortkeyConnector] ERROR FATAL: No hay mensajes de sistema. Se requiere agent_background para operar.`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
      
      // Log all messages in detail for debugging
      console.log(`[PortkeyConnector] Sending total of ${messages.length} messages to LLM:`);
      messages.forEach((msg, index) => {
        const contentLength = typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length;
        console.log(`[PortkeyConnector] Message #${index + 1} (${msg.role}): ${typeof msg.content === 'string' ? msg.content.substring(0, 50) + '...' : JSON.stringify(msg.content).substring(0, 50) + '...'} (${contentLength} caracteres)`);
      });
      
      // Execute the appropriate API call using portkey.chat.completions.create
      // This works for both OpenAI and Anthropic
      let response;
      let content;
      let usage;
      const startTime = Date.now();
      
      try {
        console.log(`[PortkeyConnector] Iniciando llamada al LLM con modelo ${usedModel} a las ${new Date().toISOString()}`);
        
        // Si streaming está habilitado, manejar de forma diferente
        if (stream === true) {
          console.log(`[PortkeyConnector] Ejecutando llamada en modo streaming`);
          const streamResponse = await portkey.chat.completions.create({
            messages,
            ...modelOptions
          });

          const duration = Date.now() - startTime;
          console.log(`[PortkeyConnector] Stream iniciado correctamente en ${duration}ms, devolviendo stream para procesamiento`);
          
          // Return the stream directly - caller must handle iteration
          return {
            stream: streamResponse,
            isStream: true,
            modelInfo: {
              model: usedModel,
              provider: provider
            }
          };
        } else {
          // Modo sin streaming (comportamiento actual)
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
            if (response.usageMetadata) {
              console.log(`[PortkeyConnector] Datos de uso (Gemini): promptTokenCount=${response.usageMetadata?.promptTokenCount}, candidatesTokenCount=${response.usageMetadata?.candidatesTokenCount}`);
              usage = {
                prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
                completion_tokens: response.usageMetadata?.candidatesTokenCount || 0,
                total_tokens: (response.usageMetadata?.promptTokenCount || 0) + (response.usageMetadata?.candidatesTokenCount || 0)
              };
              console.log(`[PortkeyConnector] Total tokens (Gemini): ${usage.total_tokens}`);
            }
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
            
            if (response.usage) {
              console.log(`[PortkeyConnector] Datos de uso estándar: ${JSON.stringify(response.usage)}`);
              usage = {
                ...response.usage,
                // Asegurar que total_tokens esté calculado
                total_tokens: response.usage.total_tokens || 
                             (response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0)
              };
              console.log(`[PortkeyConnector] Total tokens (Estándar): ${usage.total_tokens}`);
            } else {
              console.log(`[PortkeyConnector] No se encontraron datos de uso en la respuesta. Estructura: ${JSON.stringify(Object.keys(response))}`);
              // Si no hay información de uso, crear un objeto vacío con valores 0
              usage = {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
              };
            }
          }
          
          const duration = Date.now() - startTime;
          console.log(`[PortkeyConnector] LLM respondió exitosamente en ${duration}ms con ${content?.length || 0} caracteres`);
          
          // Return standardized response format with model information
          return {
            content,
            usage,
            modelInfo: {
              model: usedModel,
              provider: provider
            }
          };
        }
      } catch (apiCallError: any) {
        const duration = Date.now() - startTime;
        console.error(`[PortkeyConnector] Error calling provider API después de ${duration}ms:`, apiCallError);
        
        // Check if it's a timeout error
        if (apiCallError.message?.includes('timeout') || apiCallError.code === 'timeout') {
          console.error(`⏰ [PortkeyConnector] TIMEOUT ERROR: LLM no respondió en tiempo esperado (${duration}ms)`);
          throw new Error(`LLM Timeout: El modelo ${usedModel} no respondió en tiempo esperado (${duration}ms)`);
        }
        
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