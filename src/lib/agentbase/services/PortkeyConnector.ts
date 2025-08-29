/**
 * PortkeyConnector for standardized LLM access
 */
import { PortkeyModelOptions, PortkeyConfig } from '../models/types';
import Portkey from 'portkey-ai';
import { AIGatewayService } from './AIGatewayService';

export class PortkeyConnector {
  private portkeyConfig: PortkeyConfig;
  private defaultOptions: Partial<PortkeyModelOptions>;
  private aiGateway: AIGatewayService;
  
  constructor(config: PortkeyConfig, defaultOptions?: Partial<PortkeyModelOptions>) {
    this.portkeyConfig = config;
    this.defaultOptions = defaultOptions || {
      modelType: 'openai',
      maxTokens: 4096,
      temperature: 0.7,
      responseFormat: 'text',
      stream: false, // Default to non-streaming for stability
      streamOptions: {
        includeUsage: true
      }
    };
    this.aiGateway = new AIGatewayService();
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
        // Configuraciones de timeout alineadas con Vercel maxDuration (300s)
        timeout: 4 * 60 * 1000, // 4 minutos para requests largos (menor que Vercel)
        bodyTimeout: 4 * 60 * 1000, // 4 minutos para recibir el body completo
        headersTimeout: 30 * 1000, // 30 segundos para headers
        connectTimeout: 15 * 1000 // 15 segundos para establecer conexión
      });
      
      // Determine model options based on provider
      const modelOptions: any = {
        model: '',
        max_tokens: maxTokens || 4096
      };
      
      // Set model ID based on provider
      if (modelType === 'openai') {
        modelOptions.model = modelId || 'gpt-5-nano';
        
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
        
        // Retry logic with exponential backoff
        const maxRetries = 3;
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            console.log(`[PortkeyConnector] Intento ${attempt}/${maxRetries} para llamada al LLM`);
            
            // Si streaming está habilitado, manejar de forma diferente
            if (stream === true) {
              console.log(`[PortkeyConnector] Ejecutando llamada en modo streaming`);
              const streamResponse = await portkey.chat.completions.create({
                messages,
                ...modelOptions,
                stream: true, // Explicitly ensure streaming is enabled
                stream_options: { include_usage: true } // Request token usage in stream
              });
              
              // Check if the response contains an error (even if it's a successful HTTP response)
              if (streamResponse && typeof streamResponse === 'object' && streamResponse.body?.error) {
                const errorBody = streamResponse.body;
                if (errorBody.status === 429 || 
                    errorBody.body?.error?.message?.includes('exceeded token rate limit') ||
                    errorBody.body?.error?.message?.includes('AIServices S0 pricing tier')) {
                  throw {
                    status: 429,
                    body: errorBody.body,
                    message: errorBody.body?.error?.message || 'Rate limit exceeded'
                  };
                }
              }

              const duration = Date.now() - startTime;
              console.log(`[PortkeyConnector] Stream iniciado correctamente en ${duration}ms, devolviendo stream para procesamiento`);
              console.log(`[PortkeyConnector] 🔍 Stream response type: ${typeof streamResponse}`);
              console.log(`[PortkeyConnector] 🔍 Stream response constructor: ${streamResponse?.constructor?.name}`);
              console.log(`[PortkeyConnector] 🔍 Stream has asyncIterator: ${!!streamResponse?.[Symbol.asyncIterator]}`);
              console.log(`[PortkeyConnector] 🔍 Stream properties: ${Object.keys(streamResponse || {}).slice(0, 5).join(', ')}`);
              
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
                
                // Check if the response contains an error (even if it's a successful HTTP response)
                if (response && typeof response === 'object' && response.body?.error) {
                  const errorBody = response.body;
                  if (errorBody.status === 429 || 
                      errorBody.body?.error?.message?.includes('exceeded token rate limit') ||
                      errorBody.body?.error?.message?.includes('AIServices S0 pricing tier')) {
                    throw {
                      status: 429,
                      body: errorBody.body,
                      message: errorBody.body?.error?.message || 'Rate limit exceeded'
                    };
                  }
                }
                
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
                
                // Check if the response contains an error (even if it's a successful HTTP response)
                if (response && typeof response === 'object' && response.body?.error) {
                  const errorBody = response.body;
                  if (errorBody.status === 429 || 
                      errorBody.body?.error?.message?.includes('exceeded token rate limit') ||
                      errorBody.body?.error?.message?.includes('AIServices S0 pricing tier')) {
                    throw {
                      status: 429,
                      body: errorBody.body,
                      message: errorBody.body?.error?.message || 'Rate limit exceeded'
                    };
                  }
                }
                
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
            
            // If we reach here, the attempt was successful, break out of retry loop
            break;
            
          } catch (retryError: any) {
            lastError = retryError;
            console.error(`[PortkeyConnector] Intento ${attempt}/${maxRetries} falló:`, retryError.message);
            
            // Check if it's a 429 rate limit error
            const isRateLimitError = retryError.status === 429 || 
                                   retryError.message?.includes('rate limit') ||
                                   retryError.message?.includes('exceeded token rate limit') ||
                                   retryError.message?.includes('AIServices S0 pricing tier');
            
            // Check if it's a connection/timeout error that we should retry
            const isRetryableError = retryError.message?.includes('timeout') || 
                                   retryError.message?.includes('Connect Timeout') ||
                                   retryError.message?.includes('fetch failed') ||
                                   retryError.code === 'UND_ERR_CONNECT_TIMEOUT' ||
                                   isRateLimitError;
            
            if (!isRetryableError || attempt === maxRetries) {
              // If it's not retryable or we've exhausted retries, throw the error
              throw retryError;
            }
            
            // Calculate wait time based on error type
            let waitTime;
            if (isRateLimitError) {
              // For rate limit errors, wait longer (60 seconds as suggested in the error message)
              waitTime = 60 * 1000; // 60 seconds
              console.log(`[PortkeyConnector] Rate limit error detected, waiting ${waitTime/1000}s as suggested by API...`);
            } else {
              // For other retryable errors, use exponential backoff
              waitTime = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
              console.log(`[PortkeyConnector] Esperando ${waitTime}ms antes del siguiente intento...`);
            }
            
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
      } catch (apiCallError: any) {
        const duration = Date.now() - startTime;
        console.error(`[PortkeyConnector] Error calling provider API después de ${duration}ms:`, apiCallError);
        
        // Check if it's a 429 rate limit error from the response structure
        const isRateLimitError = apiCallError.status === 429 || 
                               apiCallError.body?.error?.message?.includes('exceeded token rate limit') ||
                               apiCallError.body?.error?.message?.includes('AIServices S0 pricing tier') ||
                               apiCallError.body?.error?.param?.error?.includes('exceeded token rate limit') ||
                               apiCallError.body?.error?.param?.error?.includes('AIServices S0 pricing tier') ||
                               apiCallError.message?.includes('rate limit') ||
                               apiCallError.message?.includes('exceeded token rate limit') ||
                               apiCallError.message?.includes('AIServices S0 pricing tier');
        
        if (isRateLimitError) {
          console.warn(`🔄 [PortkeyConnector] Rate limit error detected (429), this should have been handled by retry logic`);
          
          // Extract the specific error message from the nested structure
          const errorMessage = apiCallError.body?.error?.message || 
                              apiCallError.body?.error?.param?.error ||
                              apiCallError.message ||
                              'Rate limit exceeded';
          
          throw new Error(`Rate limit exceeded: ${errorMessage}`);
        }
        
        // Check if it's a streaming error with GPT-5 that we can fallback from
        const isStreamingError = stream === true && (
          apiCallError.message?.includes('Stream hung after role-only first chunk') ||
          apiCallError.message?.includes('Chunk timeout') ||
          apiCallError.message?.includes('timeout')
        );
        
        // Check if it's a Portkey connection error and we can fallback to direct OpenAI
        const isPortkeyConnectionError = apiCallError.message?.includes('Could not instantiate the Portkey client') ||
                                       apiCallError.message?.includes('Connect Timeout') ||
                                       apiCallError.message?.includes('fetch failed') ||
                                       apiCallError.code === 'UND_ERR_CONNECT_TIMEOUT';
        
        // Try fallback for streaming errors with GPT-5
        if (isStreamingError && provider === 'openai' && modelOptions.model === 'gpt-5') {
          console.warn(`🔄 [PortkeyConnector] GPT-5 streaming failed, trying fallback to GPT-4o...`);
          
          try {
            // Retry with GPT-4o which has more stable streaming
            const fallbackModelOptions = {
              ...modelOptions,
              model: 'gpt-4o',
              max_tokens: modelOptions.max_completion_tokens || modelOptions.max_tokens || 4096
            };
            delete fallbackModelOptions.max_completion_tokens; // GPT-4o uses max_tokens
            
            const fallbackResponse = await portkey.chat.completions.create({
              messages,
              ...fallbackModelOptions,
              stream: true,
              stream_options: { include_usage: true }
            });
            
            // Check if the fallback response contains an error
            if (fallbackResponse && typeof fallbackResponse === 'object' && fallbackResponse.body?.error) {
              const errorBody = fallbackResponse.body;
              if (errorBody.status === 429 || 
                  errorBody.body?.error?.message?.includes('exceeded token rate limit') ||
                  errorBody.body?.error?.message?.includes('AIServices S0 pricing tier')) {
                throw {
                  status: 429,
                  body: errorBody.body,
                  message: errorBody.body?.error?.message || 'Rate limit exceeded'
                };
              }
            }
            
            console.log(`✅ [PortkeyConnector] GPT-4o fallback successful`);
            return {
              stream: fallbackResponse,
              isStream: true,
              modelInfo: {
                model: 'gpt-4o',
                provider: provider,
                fallbackFrom: 'gpt-5'
              }
            };
          } catch (fallbackError: any) {
            console.error(`❌ [PortkeyConnector] GPT-4o fallback also failed:`, fallbackError.message);
            // Try non-streaming as final fallback for streaming issues
            console.warn(`🔄 [PortkeyConnector] Trying non-streaming fallback for original model...`);
            
            try {
              const nonStreamingResponse = await portkey.chat.completions.create({
                messages,
                ...modelOptions,
                stream: false // Disable streaming
              });
              
              // Check if the non-streaming fallback response contains an error
              if (nonStreamingResponse && typeof nonStreamingResponse === 'object' && nonStreamingResponse.body?.error) {
                const errorBody = nonStreamingResponse.body;
                if (errorBody.status === 429 || 
                    errorBody.body?.error?.message?.includes('exceeded token rate limit') ||
                    errorBody.body?.error?.message?.includes('AIServices S0 pricing tier')) {
                  throw {
                    status: 429,
                    body: errorBody.body,
                    message: errorBody.body?.error?.message || 'Rate limit exceeded'
                  };
                }
              }
              
              console.log(`✅ [PortkeyConnector] Non-streaming fallback successful`);
              return {
                stream: nonStreamingResponse,
                isStream: false,
                modelInfo: {
                  model: modelOptions.model,
                  provider: provider,
                  fallbackFrom: 'streaming',
                  fallbackType: 'non-streaming'
                }
              };
            } catch (nonStreamingError: any) {
              console.error(`❌ [PortkeyConnector] Non-streaming fallback also failed:`, nonStreamingError.message);
              // Continue to other fallback mechanisms below
            }
          }
        }
        
        if (isPortkeyConnectionError && provider === 'openai') {
          console.warn(`🔄 [PortkeyConnector] Portkey falló, intentando fallback con AI Gateway...`);
          
          if (!this.aiGateway.isAvailable()) {
            console.error(`❌ [PortkeyConnector] AI Gateway no está disponible`);
            throw new Error(`Portkey falló y AI Gateway no está configurado: ${apiCallError.message}`);
          }
          
          try {
            const fallbackResponse = await this.aiGateway.callAgent(messages, {
              model: modelOptions.model,
              maxTokens: modelOptions.max_tokens,
              temperature: modelOptions.temperature,
              topP: modelOptions.top_p,
              stream: stream,
              streamOptions: streamOptions
            });
            
            // Note: AI Gateway responses don't have the same error structure as Portkey
            // Errors from AI Gateway would be thrown as exceptions, not contained in response body
            
            console.log(`✅ [PortkeyConnector] Fallback con AI Gateway exitoso`);
            return fallbackResponse;
          } catch (fallbackError: any) {
            console.error(`❌ [PortkeyConnector] Fallback con AI Gateway también falló:`, fallbackError.message);
            throw new Error(`Portkey y AI Gateway fallaron: ${apiCallError.message} | Fallback: ${fallbackError.message}`);
          }
        }
        
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