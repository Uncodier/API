/**
 * PortkeyAgent for LLM communication
 */
import { BaseAgent } from './BaseAgent';
import { PortkeyAgentConnector } from '../services/PortkeyAgentConnector';
import { DbCommand, CommandExecutionResult, PortkeyModelOptions, ToolExecutionResult } from '../models/types';

/**
 * Agent that uses Portkey for LLM communication
 */
export class PortkeyAgent extends BaseAgent {
  private connector: PortkeyAgentConnector;
  private defaultOptions: Partial<PortkeyModelOptions>;
  
  constructor(
    id: string, 
    name: string, 
    connector: PortkeyAgentConnector,
    capabilities: string[] = [],
    defaultOptions?: Partial<PortkeyModelOptions>
  ) {
    super(id, name, capabilities);
    this.connector = connector;
    this.defaultOptions = defaultOptions || {};
  }
  
  /**
   * Execute a command using Portkey for LLM responses
   */
  async executeCommand(command: DbCommand): Promise<CommandExecutionResult> {
    try {
      // Validate command capabilities
      if (!this.validateCommandCapabilities(command)) {
        return {
          status: 'failed',
          error: `Agent ${this.name} does not have the required capabilities for this command`
        };
      }
      
      // Prepare messages for the agent
      const messages = this.prepareMessagesFromCommand(command);
      
      // Determine model options
      const modelOptions: PortkeyModelOptions = {
        modelType: command.model_type || this.defaultOptions.modelType || 'anthropic',
        modelId: command.model_id || this.defaultOptions.modelId,
        maxTokens: command.max_tokens || this.defaultOptions.maxTokens,
        temperature: command.temperature || this.defaultOptions.temperature,
        responseFormat: command.response_format || this.defaultOptions.responseFormat || 'text'
      };
      
      // If command has tools, execute them first
      let toolResults: ToolExecutionResult[] = [];
      if (command.tools && command.tools.length > 0) {
        toolResults = await this.executeTools(command.tools);
        
        // Add tool results to context if available
        if (toolResults.length > 0) {
          messages.push({
            role: 'user' as const,
            content: `Tool results: ${JSON.stringify(toolResults)}`
          });
        }
      }
      
      // Call the agent through Portkey
      const portkeyResponse = await this.connector.callAgent(messages, modelOptions);
      
      // Extraer información de tokens
      const portkeyUsage = this.extractTokenUsage(portkeyResponse);
      
      // Acumular con los valores existentes en el comando
      const currentInputTokens = Number(command.input_tokens || 0);
      const currentOutputTokens = Number(command.output_tokens || 0);
      
      const updatedInputTokens = currentInputTokens + (portkeyUsage.inputTokens || 0);
      const updatedOutputTokens = currentOutputTokens + (portkeyUsage.outputTokens || 0);
      
      console.log(`[PortkeyAgent:${this.id}] Tokens acumulados - Input: ${updatedInputTokens} (${currentInputTokens} + ${portkeyUsage.inputTokens}), Output: ${updatedOutputTokens} (${currentOutputTokens} + ${portkeyUsage.outputTokens})`);
      
      // Extraer la respuesta del texto o objeto
      const response = typeof portkeyResponse === 'object' && portkeyResponse.content 
        ? portkeyResponse.content 
        : portkeyResponse;
      
      // Process the response
      const results = this.processAgentResponse(response, command);
      
      // Process targets if specified
      if (command.targets && command.targets.length > 0) {
        const targetResults = await this.processTargets(command.targets, toolResults);
        results.push(...targetResults);
      }
      
      // Store the result in memory
      await this.memoryStore.store({
        userId: command.user_id,
        type: 'command_result',
        key: `cmd_result_${command.id}`,
        data: results,
        rawData: typeof response === 'string' ? response : JSON.stringify(response),
        metadata: {
          commandId: command.id,
          timestamp: new Date().toISOString()
        }
      });
      
      // Crear una copia del comando con los tokens actualizados
      const updatedCommand = {
        ...command,
        input_tokens: updatedInputTokens,
        output_tokens: updatedOutputTokens
      };
      
      return {
        status: 'completed',
        results,
        updatedCommand
      };
    } catch (error: any) {
      console.error(`[PortkeyAgent:${this.id}] Error executing command:`, error);
      
      return {
        status: 'failed',
        error: error.message
      };
    }
  }
  
  /**
   * Extrae la información de uso de tokens de la respuesta de Portkey
   */
  private extractTokenUsage(response: any): { inputTokens: number, outputTokens: number } {
    const usage = { inputTokens: 0, outputTokens: 0 };
    
    try {
      if (typeof response === 'object') {
        // Extraer del formato estándar de Portkey
        if (response.usage) {
          usage.inputTokens = response.usage.input_tokens || response.usage.prompt_tokens || 0;
          usage.outputTokens = response.usage.output_tokens || response.usage.completion_tokens || 0;
        }
        // Formato alternativo
        else if (response.inputTokenCount !== undefined && response.outputTokenCount !== undefined) {
          usage.inputTokens = response.inputTokenCount;
          usage.outputTokens = response.outputTokenCount;
        }
        // Búsqueda profunda de metadatos
        else if (response.metadata && response.metadata.usage) {
          usage.inputTokens = response.metadata.usage.input_tokens || response.metadata.usage.prompt_tokens || 0;
          usage.outputTokens = response.metadata.usage.output_tokens || response.metadata.usage.completion_tokens || 0;
        }
      }
    } catch (error) {
      console.warn(`[PortkeyAgent] Error extrayendo información de uso de tokens:`, error);
    }
    
    console.log(`[PortkeyAgent] Tokens detectados - Input: ${usage.inputTokens}, Output: ${usage.outputTokens}`);
    return usage;
  }
  
  /**
   * Prepare messages for the agent from command
   */
  private prepareMessagesFromCommand(command: DbCommand): Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | any;
  }> {
    const messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string | any;
    }> = [];
    
    // Add system message if specified
    if (command.system_prompt) {
      messages.push({
        role: 'system',
        content: command.system_prompt
      });
    } else {
      // Default system message based on agent capabilities
      messages.push({
        role: 'system',
        content: `You are ${this.name}, an AI assistant with the following capabilities: ${this.capabilities.join(', ')}.`
      });
    }
    
    // Add context as a user message if provided
    if (command.context) {
      messages.push({
        role: 'user',
        content: command.context
      });
    }
    
    // Add the main task as a user message
    messages.push({
      role: 'user',
      content: command.task
    });
    
    return messages;
  }
  
  /**
   * Process the agent response
   */
  private processAgentResponse(response: any, command: DbCommand): any[] {
    // Handle different response formats
    if (command.response_format === 'json' && typeof response === 'object') {
      return [{ type: 'json_result', content: response }];
    }
    
    // For text responses
    return [{ type: 'text_result', content: response }];
  }
  
  /**
   * Execute a specific tool
   */
  async executeTool(tool: any): Promise<any> {
    // Simple mock implementation for tools
    // In a real implementation, this would call actual tool functionality
    
    switch (tool.name) {
      case 'data_fetch':
        return this.mockDataFetch(tool.parameters);
      case 'search':
        return this.mockSearch(tool.parameters);
      case 'text_processing':
        return this.mockTextProcessing(tool.parameters);
      default:
        throw new Error(`Unsupported tool: ${tool.name}`);
    }
  }
  
  // Mock tool implementations
  
  private mockDataFetch(params: any): Promise<any> {
    return Promise.resolve({
      success: true,
      data: {
        message: `Mock data fetch with params: ${JSON.stringify(params)}`,
        timestamp: new Date().toISOString()
      }
    });
  }
  
  private mockSearch(params: any): Promise<any> {
    return Promise.resolve({
      success: true,
      results: [
        { title: "Mock search result 1", snippet: "This is a mock search result" },
        { title: "Mock search result 2", snippet: "Another mock search result" }
      ],
      query: params.query || "unknown"
    });
  }
  
  private mockTextProcessing(params: any): Promise<any> {
    const text = params.text || "Sample text";
    return Promise.resolve({
      success: true,
      processed: text.toUpperCase(),
      wordCount: text.split(/\s+/).length,
      charCount: text.length
    });
  }

  /**
   * Process target outputs based on tool results and LLM response
   */
  async processTargets(targets: any[], toolResults: ToolExecutionResult[]): Promise<any[]> {
    // Ensure toolResults is never undefined
    const safeToolResults = toolResults || [];
    
    console.log(`[PortkeyAgent:${this.id}] Procesando ${targets.length} targets`);
    
    const results: any[] = [];
    
    for (const target of targets) {
      try {
        // Determinar el tipo de target
        const targetType = Object.keys(target)[0];
        
        // Procesar según el tipo de target
        switch (targetType) {
          case 'message':
            const messageResult = this.processMessageTarget(target.message, safeToolResults);
            results.push({
              type: 'message',
              content: messageResult
            });
            break;
            
          case 'report':
            const reportResult = this.processReportTarget(target.report, safeToolResults);
            results.push({
              type: 'report',
              content: reportResult
            });
            break;
            
          case 'analysis':
            const analysisResult = this.processAnalysisTarget(target.analysis, safeToolResults);
            results.push({
              type: 'analysis',
              content: analysisResult
            });
            break;
            
          default:
            // Default handler for unknown targets
            results.push({
              type: targetType,
              content: "Processed with default handler"
            });
        }
      } catch (error: any) {
        console.error(`[PortkeyAgent:${this.id}] Error procesando target:`, error);
        results.push({
          type: 'error',
          error: error.message,
          target: target
        });
      }
    }
    
    console.log(`[PortkeyAgent:${this.id}] Targets procesados exitosamente:`, results.length);
    return results;
  }

  /**
   * Process a message target using the LLM response
   */
  private processMessageTarget(messageTarget: any, toolResults: ToolExecutionResult[]): any {
    // En este caso, para un target de tipo message, utilizamos la respuesta
    // del LLM como contenido del mensaje
    
    // Si el mensaje no tiene contenido, usamos la respuesta del LLM
    if (!messageTarget.content && this.memoryStore) {
      // Intentar obtener el resultado más reciente de la memoria
      const latestResults = this.getLatestResponseFromMemory();
      
      if (latestResults && latestResults.length > 0) {
        const textResult = latestResults.find(r => r.type === 'text_result');
        if (textResult) {
          return textResult.content;
        }
        
        // Si no se encontró un resultado de texto, usar el primer resultado
        return latestResults[0].content || "Processed message";
      }
    }
    
    // Si ya tiene contenido o no se pudo encontrar en la memoria, devolverlo tal cual
    return messageTarget.content || "Processed message";
  }

  /**
   * Process a report target
   */
  private processReportTarget(reportTarget: any, toolResults: ToolExecutionResult[]): any {
    // Implementación simple para reportes
    return {
      title: "Generated Report",
      sections: reportTarget.sections || ["summary"],
      content: "Report content would go here based on the LLM response",
      generated: new Date().toISOString()
    };
  }

  /**
   * Process an analysis target
   */
  private processAnalysisTarget(analysisTarget: any, toolResults: ToolExecutionResult[]): any {
    // Implementación simple para análisis
    return {
      insights: ["Insight 1", "Insight 2"],
      recommendations: ["Recommendation 1", "Recommendation 2"],
      confidence: 0.85,
      generated: new Date().toISOString()
    };
  }

  /**
   * Get the latest response from memory store
   */
  private getLatestResponseFromMemory(): any[] {
    // Esta es una implementación simplificada
    // En una implementación real, consultaríamos la memoria para obtener
    // la respuesta más reciente
    const latestEntries = this.memoryStore.getLatestEntries(1, 'command_result');
    
    if (latestEntries && latestEntries.length > 0) {
      return latestEntries[0].data || [];
    }
    
    return [];
  }
} 