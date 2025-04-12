/**
 * ToolEvaluatorAgent - Agente especializado para evaluar si se deben activar las herramientas
 * basado en el mensaje del usuario.
 */
import { BaseAgent } from './BaseAgent';
import { PortkeyAgentConnector } from '../services/PortkeyAgentConnector';
import { DbCommand, CommandExecutionResult, PortkeyModelOptions, ToolExecutionResult } from '../models/types';
import { TOOL_EVALUATOR_SYSTEM_PROMPT, formatToolEvaluatorPrompt } from '../prompts/tool-evaluator-prompt';

// Interfaces para el nuevo formato de respuesta
interface ToolFunctionCall {
  reasoning: string;
  type: "function_call";
  name: string;
  arguments: string;
}

interface ToolExclusion {
  reasoning: string;
  type: "exclusion";
  name: string;
}

type ToolDecision = ToolFunctionCall | ToolExclusion;

export class ToolEvaluatorAgent extends BaseAgent {
  private connector: PortkeyAgentConnector;
  private defaultOptions: Partial<PortkeyModelOptions>;

  constructor(
    id: string, 
    name: string, 
    connector: PortkeyAgentConnector,
    capabilities: string[] = ['tool_evaluation'],
    defaultOptions?: Partial<PortkeyModelOptions>
  ) {
    super(id, name, capabilities);
    this.connector = connector;
    this.defaultOptions = defaultOptions || {};
  }

  /**
   * Evalúa las herramientas disponibles y decide cuáles activar basado en el mensaje
   */
  async executeCommand(command: DbCommand): Promise<CommandExecutionResult> {
    try {
      console.log(`[ToolEvaluatorAgent:${this.id}] Evaluando herramientas para el comando: ${command.id}`);
      
      // Verificar si hay herramientas para evaluar
      if (!command.tools || command.tools.length === 0) {
        console.log(`[ToolEvaluatorAgent:${this.id}] No hay herramientas para evaluar`);
        return {
          status: 'completed',
          results: [{
            type: 'tool_evaluation',
            content: { message: "No tools to evaluate" }
          }]
        };
      }

      // Usar el contexto completo del comando sin extraer nada
      const userContext = command.context || '';
      
      // Preparar los mensajes para el LLM usando las plantillas de prompt
      const messages = [
        {
          role: 'system' as const,
          content: TOOL_EVALUATOR_SYSTEM_PROMPT
        },
        {
          role: 'user' as const,
          content: formatToolEvaluatorPrompt(userContext, command.tools)
        }
      ];
      
      // Configurar opciones del modelo
      const modelOptions: PortkeyModelOptions = {
        modelType: command.model_type || this.defaultOptions.modelType || 'anthropic',
        modelId: command.model_id || this.defaultOptions.modelId,
        maxTokens: command.max_tokens || this.defaultOptions.maxTokens || 1000,
        temperature: command.temperature || this.defaultOptions.temperature || 0,
        responseFormat: 'json'
      };
      
      console.log(`[ToolEvaluatorAgent:${this.id}] Enviando evaluación al LLM`);
      
      // Enviar al LLM para evaluación
      const portkeyResponse = await this.connector.callAgent(messages, modelOptions);
      
      // Extraer y acumular los tokens
      const portkeyUsage = this.extractTokenUsage(portkeyResponse);
      
      // Acumular con los valores existentes en el comando
      const currentInputTokens = Number(command.input_tokens || 0);
      const currentOutputTokens = Number(command.output_tokens || 0);
      
      command.input_tokens = currentInputTokens + (portkeyUsage.inputTokens || 0);
      command.output_tokens = currentOutputTokens + (portkeyUsage.outputTokens || 0);
      
      console.log(`[ToolEvaluatorAgent:${this.id}] Tokens acumulados - Input: ${command.input_tokens}, Output: ${command.output_tokens}`);
      
      // Extraer la respuesta del texto o objeto
      const response = typeof portkeyResponse === 'object' && portkeyResponse.content 
        ? portkeyResponse.content 
        : portkeyResponse;
      
      console.log(`[ToolEvaluatorAgent:${this.id}] Respuesta recibida:`, JSON.stringify(response).substring(0, 200) + '...');
      
      // Procesar la respuesta
      const toolDecisions = this.processToolEvaluationResponse(response, command.tools);
      
      // Actualizar el estado de las herramientas
      const updatedTools = this.updateToolsStatus(command.tools, toolDecisions);
      
      console.log(`[ToolEvaluatorAgent:${this.id}] Herramientas actualizadas:`, JSON.stringify(updatedTools).substring(0, 200) + '...');
      
      // Crear una copia del comando original con las herramientas actualizadas
      const updatedCommand = { 
        ...command, 
        tools: updatedTools,
        input_tokens: command.input_tokens,
        output_tokens: command.output_tokens
      };
      
      // Devolver los resultados
      return {
        status: 'completed',
        results: [
          {
            type: 'tool_evaluation',
            content: {
              message: "Tool evaluation completed",
              evaluated_tools: toolDecisions,
              updated_tools: updatedTools  // Incluir las herramientas actualizadas en el resultado
            }
          }
        ],
        updatedCommand: updatedCommand // Incluir el comando actualizado para que se guarde correctamente
      };
    } catch (error: any) {
      console.error(`[ToolEvaluatorAgent:${this.id}] Error evaluando herramientas:`, error);
      
      return {
        status: 'failed',
        error: `Error evaluating tools: ${error.message}`
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
      console.warn(`[ToolEvaluatorAgent] Error extrayendo información de uso de tokens:`, error);
    }
    
    console.log(`[ToolEvaluatorAgent] Tokens detectados - Input: ${usage.inputTokens}, Output: ${usage.outputTokens}`);
    return usage;
  }

  /**
   * Extrae el mensaje del usuario del contexto
   * @deprecated No longer used - we pass the full context
   */
  private extractUserMessage(context: string): string {
    // Esta función ya no se usa, pasamos el contexto completo
    return context;
  }

  /**
   * Procesa la respuesta de evaluación de herramientas
   */
  private processToolEvaluationResponse(response: any, tools: any[]): ToolDecision[] {
    let toolDecisions: ToolDecision[] = [];

    try {
      // Intentar procesar la respuesta como JSON
      if (typeof response === 'string') {
        try {
          response = JSON.parse(response);
        } catch (e) {
          // Si no es un JSON válido, buscar bloques de JSON en el texto
          const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/) || 
                           response.match(/\{[\s\S]*\}/);
          
          if (jsonMatch) {
            response = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          }
        }
      }

      // Validar que la respuesta sea un array
      if (response && Array.isArray(response)) {
        toolDecisions = response as ToolDecision[];
      } else {
        console.warn('[ToolEvaluatorAgent] Formato de respuesta inesperado:', response);
        // Si la respuesta está en el formato antiguo, convertirla al nuevo formato
        if (response && response.tool_decisions && Array.isArray(response.tool_decisions)) {
          toolDecisions = response.tool_decisions.map((decision: any) => {
            if (decision.should_use) {
              return {
                reasoning: decision.reasoning || "Tool should be used based on user request",
                type: "function_call" as const,
                name: decision.tool_name,
                arguments: JSON.stringify(decision.parameters || {})
              };
            } else {
              return {
                reasoning: decision.reasoning || "Tool should not be used based on user request",
                type: "exclusion" as const,
                name: decision.tool_name
              };
            }
          }).filter((decision: any) => decision !== null);
        } else {
          // Si no hay ningún formato reconocible, devolvemos un array vacío
          toolDecisions = [];
        }
      }
    } catch (error) {
      console.error('[ToolEvaluatorAgent] Error procesando respuesta:', error);
      toolDecisions = [];
    }

    return toolDecisions;
  }

  /**
   * Actualiza el estado de las herramientas según las decisiones
   */
  private updateToolsStatus(tools: any[], decisions: ToolDecision[]): any[] {
    return tools.map(tool => {
      // Crear una copia de la herramienta
      const updatedTool = { ...tool };
      
      // Buscar decisiones relevantes para esta herramienta
      const functionCall = decisions.find(d => d.type === "function_call" && d.name === tool.name) as ToolFunctionCall | undefined;
      const exclusion = decisions.find(d => d.type === "exclusion" && d.name === tool.name) as ToolExclusion | undefined;
      
      if (functionCall) {
        try {
          // Obtener los argumentos
          let args = {};
          try {
            args = JSON.parse(functionCall.arguments);
          } catch (error) {
            const e = error as Error;
            console.warn(`[ToolEvaluatorAgent] Error al parsear argumentos para ${tool.name}:`, e);
            throw new Error(`Invalid arguments format: ${e.message}`);
          }
          
          // Verificar si existen argumentos requeridos
          const missingRequiredArgs = this.checkRequiredArguments(tool, args);
          
          if (missingRequiredArgs.length > 0) {
            // Faltan argumentos requeridos, marcar como fallido
            updatedTool.status = 'function_call_failed';
            updatedTool.evaluation = {
              reasoning: `Missing required arguments: ${missingRequiredArgs.join(', ')}`,
              type: "function_call_failed"
            };
          } else {
            // La herramienta debe ser activada
            updatedTool.status = 'ready';
            
            // Añadir los argumentos directamente y también en parameters
            updatedTool.arguments = args;
            updatedTool.parameters = {
              ...updatedTool.parameters,
              ...args
            };
            
            // Guardar el razonamiento
            updatedTool.evaluation = {
              reasoning: functionCall.reasoning || "Tool should be used based on user request",
              type: "function_call"
            };
          }
        } catch (error) {
          const e = error as Error;
          // Error en el procesamiento de argumentos
          updatedTool.status = 'function_call_failed';
          updatedTool.evaluation = {
            reasoning: `Error processing arguments: ${e.message}`,
            type: "function_call_failed"
          };
        }
      } else if (exclusion) {
        // La herramienta debe ser excluida explícitamente
        updatedTool.status = 'skipped';
        
        // Guardar el razonamiento
        updatedTool.evaluation = {
          reasoning: exclusion.reasoning || "Tool should not be used based on user request",
          type: "exclusion"
        };
      } else {
        // No hay decisión específica para esta herramienta, se considera skipped
        updatedTool.status = 'skipped';
        
        // No hay razonamiento específico
        updatedTool.evaluation = {
          reasoning: "No specific decision for this tool",
          type: "none"
        };
      }
      
      return updatedTool;
    });
  }

  /**
   * Verifica que todos los argumentos requeridos estén presentes
   * @returns Array con los nombres de los argumentos requeridos que faltan
   */
  private checkRequiredArguments(tool: any, args: any): string[] {
    const missingArgs: string[] = [];
    
    // Verificar si la herramienta tiene parámetros con propiedades required
    if (tool.parameters && tool.parameters.required && Array.isArray(tool.parameters.required)) {
      // Verificar cada argumento requerido
      for (const requiredArg of tool.parameters.required) {
        if (args[requiredArg] === undefined) {
          missingArgs.push(requiredArg);
        }
      }
    }
    
    // Verificar las propiedades individuales marcadas como requeridas
    if (tool.parameters && tool.parameters.properties) {
      for (const [propName, propValue] of Object.entries(tool.parameters.properties)) {
        // Asegurar que propValue es un objeto
        const propDetails = propValue as Record<string, any>;
        // Si la propiedad es requerida pero no está en los argumentos
        if (propDetails.required === true && args[propName] === undefined) {
          missingArgs.push(propName);
        }
      }
    }
    
    return missingArgs;
  }
} 