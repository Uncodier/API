/**
 * ToolEvaluator - Procesador especializado para evaluar qué herramientas
 * deben activarse basado en el mensaje del usuario.
 */
import { Base } from '../Base';
import { PortkeyConnector } from '../../services/PortkeyConnector';
import { DbCommand, CommandExecutionResult, PortkeyModelOptions } from '../../models/types';
import { TOOL_EVALUATOR_SYSTEM_PROMPT } from '../../prompts/tool-evaluator-prompt';

// Import utilities
import { extractTokenUsage } from './tokenUtils';
import { processToolEvaluationResponse, generateFunctions } from './responseProcessor';
import { prepareMessagesFromCommand, validateAndNormalizeTools } from './messageFormatter';
import { FunctionCall } from './types';
import { CommandCache } from '../../services/command/CommandCache';

export class ToolEvaluator extends Base {
  private connector: PortkeyConnector;
  private defaultOptions: Partial<PortkeyModelOptions>;
  // Propiedades adicionales del agente
  readonly description?: string;
  readonly systemPrompt?: string;
  readonly agentSystemPrompt?: string;

  constructor(
    id: string, 
    name: string, 
    connector: PortkeyConnector,
    capabilities: string[] = ['tool_evaluation'],
    defaultOptions?: Partial<PortkeyModelOptions>,
    description?: string,
    systemPrompt?: string,
    agentSystemPrompt?: string
  ) {
    super(id, name, capabilities);
    this.connector = connector;
    this.defaultOptions = defaultOptions || {};
    this.description = description;
    this.systemPrompt = systemPrompt;
    this.agentSystemPrompt = agentSystemPrompt;
    
    // Loguear para depuración
    if (this.description) console.log(`📝 [ToolEvaluator] Descripción: ${this.description.substring(0, 100)}...`);
    if (this.systemPrompt) console.log(`🧠 [ToolEvaluator] System Prompt: ${this.systemPrompt.substring(0, 100)}...`);
    if (this.agentSystemPrompt) console.log(`🧠 [ToolEvaluator] Agent System Prompt: ${this.agentSystemPrompt.substring(0, 100)}...`);
    
    // Verificar que el prompt default esté cargado correctamente
    console.log(`🔍 [ToolEvaluator] Default prompt loaded: ${TOOL_EVALUATOR_SYSTEM_PROMPT.substring(0, 100)}...`);
    console.log(`🔍 [ToolEvaluator] Default prompt contains 'function': ${TOOL_EVALUATOR_SYSTEM_PROMPT.includes('function')}`);
    console.log(`🔍 [ToolEvaluator] Default prompt contains 'array': ${TOOL_EVALUATOR_SYSTEM_PROMPT.includes('array')}`);
  }

  /**
   * Execute command by evaluating tools based on user message
   */
  async executeCommand(command: DbCommand): Promise<CommandExecutionResult> {
    try {
      console.log(`[ToolEvaluator] Evaluating tools for command: ${command.id}`);
      
      // Verificar si existe agent_background
      if (!command.agent_background) {
        console.log(`[ToolEvaluator] Comando sin agent_background, intentando recuperar...`);
        
        // Intentar recuperar desde la caché
        const cachedCommand = CommandCache.getCachedCommand(command.id);
        if (cachedCommand?.agent_background) {
          console.log(`[ToolEvaluator] agent_background recuperado desde caché`);
          command.agent_background = cachedCommand.agent_background;
        } 
        // Si no hay agent_background, intentar generarlo
        else if (command.agent_id) {
          throw new Error(`Falta agent_background para agente ${command.agent_id}`);
        } else {
          throw new Error(`Comando sin agent_id ni agent_background. Imposible evaluar herramientas.`);
        }
      }
      
      // Check if there are tools to evaluate
      if (!command.tools || command.tools.length === 0) {
        console.log(`[ToolEvaluator] No tools to evaluate`);
        
        // No tools to evaluate, return empty functions array
        return {
          status: 'completed',
          results: [{
            type: 'tool_evaluation',
            content: {
              message: "No tools to evaluate",
              updated_tools: []
            }
          }],
          updatedCommand: {
            ...command,
            functions: [] // Set empty functions array
          }
        };
      }
      
      // Normalize and validate tools
      command.tools = validateAndNormalizeTools(command.tools);
      
      // Process the request
      let functions: Function[] = [];
      
      try {
        if (!command.agent_background) {
          throw new Error('agent_background obligatorio para evaluar herramientas');
        }
        
        // Preparar prompts específicos del agente
        let customSystemPrompt = this.systemPrompt;
        
        // Si hay un agentSystemPrompt, combinarlo con el systemPrompt
        if (this.agentSystemPrompt && this.agentSystemPrompt.trim().length > 0) {
          console.log(`[ToolEvaluator] Agregando agent system prompt (${this.agentSystemPrompt.length} caracteres)`);
          // Si ya existe un system prompt, combinarlo
          if (customSystemPrompt) {
            customSystemPrompt = `${this.agentSystemPrompt}\n\n${customSystemPrompt}`;
          } else {
            customSystemPrompt = this.agentSystemPrompt;
          }
        }
        
        // Usar la función prepareMessagesFromCommand para preparar los mensajes
        const messages = prepareMessagesFromCommand(command, customSystemPrompt);
        
        // Configurar opciones del modelo
        const modelOptions = {
          modelType: 'openai' as 'anthropic' | 'openai' | 'gemini',
          modelId: 'gpt-4o',
          maxTokens: 4000,
          temperature: 0.7,
         // responseFormat: 'json' as 'json' | 'text'
        };
        
        // Llamar a la API a través del conector
        const portkeyResponse = await this.connector.callAgent(messages, modelOptions);
        console.log("[ToolEvaluator] Response received");
        
        // Extraer el contenido de la respuesta
        const content = portkeyResponse.content;
        if (!content) {
          throw new Error('No se recibió respuesta del modelo');
        }
        
        // Extraer token usage para la respuesta final
        const portkeyUsage = {
          inputTokens: portkeyResponse.usage?.prompt_tokens || 0,
          outputTokens: portkeyResponse.usage?.completion_tokens || 0
        };
        
        // Intentar analizar la respuesta como JSON
        try {
          // Verificar si es un string JSON o un objeto
          let jsonContent = typeof content === 'string' ? content : JSON.stringify(content);
          
          // Si la respuesta contiene un bloque de código, extraerlo
          if (typeof jsonContent === 'string') {
            const codeBlockMatch = jsonContent.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (codeBlockMatch && codeBlockMatch[1]) {
              jsonContent = codeBlockMatch[1].trim();
            }
          }
          
          // Intentar analizar el JSON
          try {
            functions = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
          } catch (jsonError) {
            console.error("[ToolEvaluator] Failed to parse JSON. Attempting cleanup:", jsonError);
            
            // Intentar pasos adicionales de limpieza si es una cadena
            if (typeof jsonContent === 'string') {
              const cleanedJson = jsonContent
                .replace(/,\s*}/g, '}')       // Eliminar comas finales en objetos
                .replace(/,\s*\]/g, ']')      // Eliminar comas finales en arrays
                .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":') // Asegurar que los nombres de propiedades tienen comillas
                .replace(/\\/g, '\\\\');      // Escapar barras invertidas
              
              functions = JSON.parse(cleanedJson);
            } else {
              throw new Error('El contenido de la respuesta no es un formato JSON válido');
            }
          }
        } catch (parseError) {
          console.error("[ToolEvaluator] Error parsing functions:", parseError);
          throw new Error('Falló el análisis de la respuesta para la evaluación de herramientas');
        }
        
        const updatedCommand = {
          ...command,
          functions: functions // Only update the functions array
        };
        
        // Return results with original tools - no modifications to tools
        return {
          status: 'completed',
          results: [{
            type: 'tool_evaluation',
            content: {
              message: "Tool evaluation completed",
              updated_tools: command.tools // Return original tools instead of modifying them
            }
          }],
          updatedCommand: updatedCommand,
          inputTokens: portkeyUsage.inputTokens,
          outputTokens: portkeyUsage.outputTokens
        };
      } catch (error: any) {
        console.error(`[ToolEvaluator] Error evaluating tools: ${error.message}`);
        return {
          status: 'failed',
          error: `Tool evaluation failed: ${error.message}`
        };
      }
    } catch (error: any) {
      console.error(`[ToolEvaluator] Error in executeCommand: ${error.message}`);
      return {
        status: 'failed',
        error: error.message
      };
    }
  }
}

// Export types for external use
export * from './types'; 