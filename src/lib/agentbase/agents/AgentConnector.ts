/**
 * AgentConnector - Agente que utiliza modelos de lenguaje a través de Portkey
 * para generar respuestas basadas en comandos.
 */
import { Base } from './Base';
import { PortkeyConnector } from '../services/PortkeyConnector';
import { DbCommand, CommandExecutionResult, PortkeyModelOptions } from '../models/types';

export class AgentConnector extends Base {
  private connector: PortkeyConnector;
  private defaultOptions: Partial<PortkeyModelOptions>;
  // Propiedades específicas del agente
  readonly description?: string;
  readonly systemPrompt?: string;
  readonly background?: string;
  
  constructor(
    id: string, 
    name: string, 
    connector: PortkeyConnector,
    capabilities: string[] = [],
    options?: {
      defaultOptions?: Partial<PortkeyModelOptions>;
      description?: string;
      systemPrompt?: string;
      background?: string;
    }
  ) {
    super(id, name, capabilities);
    this.connector = connector;
    this.defaultOptions = options?.defaultOptions || {};
    
    // Asignar propiedades específicas del agente
    this.description = options?.description;
    this.systemPrompt = options?.systemPrompt;
    this.background = options?.background;
    
    // Loggear la configuración para depuración
    console.log(`🔧 AgentConnector inicializado: ${id} (${name})`);
    if (this.description) console.log(`📝 Descripción: ${this.description.substring(0, 100)}...`);
    if (this.systemPrompt) console.log(`🧠 System Prompt: ${this.systemPrompt.substring(0, 100)}...`);
    if (this.background) console.log(`🔍 Background: ${this.background.substring(0, 100)}...`);
  }
  
  /**
   * Execute command by processing user message with an agent
   */
  async executeCommand(command: DbCommand): Promise<CommandExecutionResult> {
    try {
      // Prepare messages from the command
      const messages = this.prepareMessagesFromCommand(command);
      
      console.log(`📝 [AgentConnector:${this.id}] Executing command ${command.id}: ${command.task.substring(0, 50)}...`);
      console.log(`📝 [AgentConnector:${this.id}] Detalles del modelo:
        command.model: ${command.model || 'undefined'}
        command.model_id: ${command.model_id || 'undefined'}
        command.model_type: ${command.model_type || 'undefined'}
      `);
      
      // Configure model options for portkey
      const modelOptions: PortkeyModelOptions = {
        modelType: command.model_type || this.defaultOptions.modelType || 'openai',
        modelId: command.model_id || command.model || this.defaultOptions.modelId || 'gpt-4.1-nano',
        maxTokens: command.max_tokens || this.defaultOptions.maxTokens || 4000,
        temperature: command.temperature || this.defaultOptions.temperature || 0.7,
        responseFormat: command.response_format || this.defaultOptions.responseFormat || 'text',
        stream: command.metadata?.stream !== false, // Stream por defecto a menos que se desactive explícitamente
      };
      
      console.log(`📝 [AgentConnector:${this.id}] Opciones finales para Portkey:
        modelType: ${modelOptions.modelType}
        modelId: ${modelOptions.modelId}
        maxTokens: ${modelOptions.maxTokens}
        temperature: ${modelOptions.temperature}
        responseFormat: ${modelOptions.responseFormat}
        stream: ${modelOptions.stream ? 'true' : 'false'}
      `);
      
      // Si se requiere streaming, establecer las opciones
      if (modelOptions.stream) {
        modelOptions.streamOptions = {
          includeUsage: true
        };
        console.log(`[AgentConnector:${this.id}] Streaming habilitado para este comando`);
      }
      
      // Si el comando tiene funciones, ejecutarlas primero (nuevo formato)
      let toolResults = [];
      if (command.functions && command.functions.length > 0) {
        console.log(`[AgentConnector:${this.id}] Ejecutando ${command.functions.length} funciones en nuevo formato`);
        toolResults = await this.executeFunctions(command.functions);
        
        // Añadir resultados de herramientas al contexto si están disponibles
        if (toolResults.length > 0) {
          messages.push({
            role: 'user',
            content: `Tool results: ${JSON.stringify(toolResults)}`
          });
        }
      }
      // Sino, si el comando tiene herramientas, ejecutarlas en formato antiguo (compatibilidad)
      else if (command.tools && command.tools.length > 0) {
        console.log(`[AgentConnector:${this.id}] Ejecutando ${command.tools.length} herramientas en formato antiguo`);
        toolResults = await this.executeTools(command.tools);
        
        // Añadir resultados de herramientas al contexto si están disponibles
        if (toolResults.length > 0) {
          messages.push({
            role: 'user',
            content: `Tool results: ${JSON.stringify(toolResults)}`
          });
        }
      }
      
      // Llamar al agente a través de Portkey
      const portkeyResponse = await this.connector.callAgent(messages, modelOptions);
      
      // Verificar si es una respuesta de streaming
      if (modelOptions.stream) {
        console.log(`[AgentConnector:${this.id}] Respuesta de streaming recibida, devolviendo stream para procesamiento`);
        // En caso de streaming, devolver una respuesta especial que indica que se está usando streaming
        return {
          status: 'completed',
          results: [{ type: 'stream', stream: portkeyResponse }]
        };
      }
      
      // Para respuestas normales (no streaming), procesarlas como siempre
      // Extraer información de tokens
      const portkeyUsage = this.extractTokenUsage(portkeyResponse);
      
      // Procesar la respuesta del agente
      let processedResults = this.processAgentResponse(portkeyResponse, command);
      
      return {
        status: 'completed',
        results: processedResults,
        inputTokens: portkeyUsage.inputTokens,
        outputTokens: portkeyUsage.outputTokens
      };
    } catch (error: any) {
      console.error(`[AgentConnector:${this.id}] Error executing command:`, error);
      
      return {
        status: 'failed',
        error: error.message
      };
    }
  }
  
  /**
   * Procesa un stream de Portkey y devuelve los chunks de texto a medida que llegan
   * Esta función se usa en el frontend para manejar la respuesta de streaming
   */
  async processStream(stream: any, callback: (chunk: string, done: boolean) => void): Promise<void> {
    try {
      let fullContent = '';
      let usageInfo = { inputTokens: 0, outputTokens: 0 };
      
      console.log(`[AgentConnector:${this.id}] Procesando stream...`);
      
      // Usar el stream para recibir chunks
      for await (const chunk of stream) {
        // Si es el chunk final con información de uso
        if (chunk.usage) {
          usageInfo = {
            inputTokens: chunk.usage.prompt_tokens || chunk.usage.input_tokens || 0,
            outputTokens: chunk.usage.completion_tokens || chunk.usage.output_tokens || 0
          };
          console.log(`[AgentConnector:${this.id}] Recibida información de uso: ${JSON.stringify(usageInfo)}`);
          continue;
        }
        
        // Extraer el contenido según el tipo de proveedor
        let content = '';
        if (chunk.choices?.[0]?.delta?.content) {
          // OpenAI format
          content = chunk.choices[0].delta.content;
        } else if (chunk.content?.[0]?.text) {
          // Anthropic format
          content = chunk.content[0].text;
        } else if (chunk.candidates?.[0]?.content?.parts?.[0]?.text) {
          // Gemini format
          content = chunk.candidates[0].content.parts[0].text;
        }
        
        if (content) {
          fullContent += content;
          console.log(`[AgentConnector:${this.id}] Chunk recibido: ${content.substring(0, 50)}...`);
          // Llamar al callback con el nuevo chunk
          callback(content, false);
        }
      }
      
      // Finalizar el stream
      console.log(`[AgentConnector:${this.id}] Stream completado. Tokens: input=${usageInfo.inputTokens}, output=${usageInfo.outputTokens}`);
      callback('', true);
      
    } catch (error: any) {
      console.error(`[AgentConnector:${this.id}] Error procesando stream:`, error);
      callback(`Error: ${error.message}`, true);
    }
  }
  
  /**
   * Prepara los mensajes para el agente a partir del comando
   */
  private prepareMessagesFromCommand(command: DbCommand): Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | any;
  }> {
    const messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string | any;
    }> = [];
    
    // Añadir agent_background como primer mensaje del sistema si está disponible
    if (command.agent_background) {
      let agentInfo = command.agent_background;
      console.log(`🧠 [AgentConnector:${this.id}] Usando agent_background explícito del comando como primer mensaje del sistema`);
      console.log(`🧠 [AgentConnector:${this.id}] Longitud del system message: ${command.agent_background.length} caracteres`);
      
      messages.push({
        role: 'system',
        content: command.agent_background
      });
      
      console.log(`📝 [AgentConnector:${this.id}] Mensaje de sistema establecido con agent_background`);
    } 
    // Si no hay agent_background, usar fallbacks
    else if (command.agent_id) {
      // Fallback que incluye instrucciones específicas sobre el nombre
      const agentInfo = `You are ${this.name} (ID: ${this.id}). You have the following capabilities: ${this.capabilities.join(', ')}.

Instructions:
1. Respond helpfully to user requests.
2. Use your capabilities effectively.
3. Be concise and clear in your responses.
4. Your name is "${this.name}" - whenever asked about your name, identity or what you are, respond with this name.`;

      console.log(`⚠️ [AgentConnector:${this.id}] agent_background NO disponible, usando fallback con nombre específico`);
      console.log(`🧠 [AgentConnector:${this.id}] Longitud del system message: ${agentInfo.length} caracteres`);
      
      messages.push({
        role: 'system',
        content: agentInfo
      });
      
      console.log(`📝 [AgentConnector:${this.id}] Mensaje de sistema establecido con fallback de agente`);
      
      // Añadir mensaje del sistema si se especifica (solo si no hay agent_background)
      if (command.system_prompt) {
        messages.push({
          role: 'system',
          content: command.system_prompt
        });
      }
    } 
    // Si no hay agent_id ni agent_background
    else {
      // Mensaje del sistema predeterminado basado en las capacidades del agente
      const defaultSystemPrompt = `You are ${this.name}, an AI assistant with the following capabilities: ${this.capabilities.join(', ')}.`;
      
      messages.push({
        role: 'system',
        content: command.system_prompt || defaultSystemPrompt
      });
      
      console.log(`📝 [AgentConnector:${this.id}] Mensaje de sistema establecido con prompt predeterminado`);
    }
    
    // Añadir contexto como mensaje de usuario si se proporciona
    if (command.context) {
      messages.push({
        role: 'user',
        content: command.context
      });
    }
    
    // Añadir la tarea principal como mensaje de usuario
    messages.push({
      role: 'user',
      content: command.task
    });
    
    return messages;
  }
  
  /**
   * Procesa la respuesta del agente
   */
  private processAgentResponse(response: any, command: DbCommand): any[] {
    try {
      const content = typeof response === 'object' && response.content 
        ? response.content 
        : response;
      
      // Log para verificar si la respuesta contiene el nombre correcto
      if (typeof content === 'string') {
        const namePattern = /(me llamo|mi nombre es|soy|I am|my name is)\s+([^.,!?]+)/i;
        const match = content.match(namePattern);
        
        if (match) {
          const mentionedName = match[2].trim();
          const expectedName = this.name;
          
          if (mentionedName.toLowerCase().includes('asistente') || 
              mentionedName.toLowerCase().includes('assistant')) {
            console.log(`⚠️ [AgentConnector] El modelo respondió con nombre genérico "${mentionedName}" en lugar de "${expectedName}"`);
          } else if (mentionedName.toLowerCase().includes(expectedName.toLowerCase())) {
            console.log(`✅ [AgentConnector] El modelo respondió correctamente con el nombre "${mentionedName}"`);
          } else {
            console.log(`⚠️ [AgentConnector] El modelo respondió con nombre incorrecto "${mentionedName}" en lugar de "${expectedName}"`);
          }
        }
      }
      
      // Manejar diferentes formatos de respuesta según lo especificado en el comando
      if (command.response_format === 'json') {
        // Intentar extraer como JSON si ese es el formato esperado
        let jsonContent;
        
        if (typeof content === 'string') {
          try {
            // Intentar analizar la cadena como JSON
            jsonContent = JSON.parse(content);
          } catch (e) {
            // Si falla, buscar bloques de código JSON en la respuesta
            const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || 
                           content.match(/\{[\s\S]*\}/);
            
            if (jsonMatch) {
              try {
                jsonContent = JSON.parse(jsonMatch[1] || jsonMatch[0]);
              } catch (e2) {
                // Si todo falla, devolver la cadena original en un objeto
                jsonContent = { message: { content } };
              }
            } else {
              // Si no se encuentra bloque JSON, envolver en objeto
              jsonContent = { message: { content } };
            }
          }
        } else {
          // Ya es un objeto, usarlo directamente
          jsonContent = content;
        }
        
        return [{ type: 'json_result', content: jsonContent }];
      } else {
        // Para respuestas de texto, crear un resultado de mensaje simple
        return [{ 
          message: {
            content: typeof content === 'string' ? content : JSON.stringify(content)
          }
        }];
      }
    } catch (error) {
      console.error('[AgentConnector] Error processing response:', error);
      // En caso de error, devolver la respuesta en bruto
      return [{ 
        message: { 
          content: "Error processing response. Please try again." 
        }
      }];
    }
  }
}