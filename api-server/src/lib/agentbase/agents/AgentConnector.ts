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
   * Ejecuta un comando utilizando Portkey para obtener respuestas del LLM
   */
  async executeCommand(command: DbCommand): Promise<CommandExecutionResult> {
    try {
      // Validar que el comando pueda ser ejecutado por este agente
      if (!this.validateCommandCapabilities(command)) {
        return {
          status: 'failed',
          error: `El agente ${this.name} no tiene las capacidades necesarias para ejecutar este comando`
        };
      }
      
      // Almacenar información del agente en la propiedad agent_background del comando
      const agentBackground = `You are ${this.name} (ID: ${this.id}), an AI assistant with the following capabilities: ${this.capabilities.join(', ')}.`;
      
      // Preparar mensajes para el agente
      const messages = this.prepareMessagesFromCommand(command);
      
      // Determinar opciones del modelo
      const modelOptions: PortkeyModelOptions = {
        modelType: command.model_type || this.defaultOptions.modelType || 'openai',
        modelId: command.model_id || this.defaultOptions.modelId || 'gpt-4o',
        maxTokens: command.max_tokens || this.defaultOptions.maxTokens || 4000,
        temperature: command.temperature || this.defaultOptions.temperature || 0.7,
        responseFormat: command.response_format || this.defaultOptions.responseFormat || 'text'
      };
      
      // Si el comando tiene herramientas, ejecutarlas primero
      let toolResults = [];
      if (command.tools && command.tools.length > 0) {
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
    
    // Añadir información del agente como primer mensaje si hay agent_id disponible
    if (command.agent_id) {
      // Usar agent_background si está disponible, sino generarlo con nombre específico
      let agentInfo = "";
      
      if (command.agent_background) {
        agentInfo = command.agent_background;
        console.log(`🧠 [AgentConnector:${this.id}] Usando agent_background explícito del comando`);
      } else {
        // Fallback que incluye instrucciones específicas sobre el nombre
        agentInfo = `You are ${this.name} (ID: ${this.id}). You have the following capabilities: ${this.capabilities.join(', ')}.

Instructions:
1. Respond helpfully to user requests.
2. Use your capabilities effectively.
3. Be concise and clear in your responses.
4. Your name is "${this.name}" - whenever asked about your name, identity or what you are, respond with this name.`;

        console.log(`⚠️ [AgentConnector:${this.id}] agent_background NO disponible, usando fallback con nombre específico`);
      }
      
      // Log detallado del contenido completo
      console.log(`🧠 [AgentConnector:${this.id}] Contenido del system message:
${agentInfo}`);
      
      messages.push({
        role: 'system',
        content: agentInfo
      });
      
      console.log(`📝 [AgentConnector:${this.id}] Mensaje de sistema establecido con agent_background`);
    }
    
    // Añadir mensaje del sistema si se especifica
    if (command.system_prompt) {
      messages.push({
        role: 'system',
        content: command.system_prompt
      });
    } else if (!command.agent_id) {
      // Mensaje del sistema predeterminado basado en las capacidades del agente (solo si no agregamos información del agente)
      messages.push({
        role: 'system',
        content: `You are ${this.name}, an AI assistant with the following capabilities: ${this.capabilities.join(', ')}.`
      });
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