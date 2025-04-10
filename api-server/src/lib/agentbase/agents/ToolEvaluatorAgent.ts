/**
 * ToolEvaluatorAgent - Agente especializado para evaluar si se deben activar las herramientas
 * basado en el mensaje del usuario.
 */
import { BaseAgent } from './BaseAgent';
import { PortkeyAgentConnector } from '../services/PortkeyAgentConnector';
import { DbCommand, CommandExecutionResult, PortkeyModelOptions, ToolExecutionResult } from '../models/types';
import { TOOL_EVALUATOR_SYSTEM_PROMPT, formatToolEvaluatorPrompt } from '../prompts/tool-evaluator-prompt';

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
      const response = await this.connector.callAgent(messages, modelOptions);
      
      console.log(`[ToolEvaluatorAgent:${this.id}] Respuesta recibida:`, JSON.stringify(response).substring(0, 200) + '...');
      
      // Procesar la respuesta
      const toolDecisions = this.processToolEvaluationResponse(response, command.tools);
      
      // Actualizar el estado de las herramientas
      const updatedTools = this.updateToolsStatus(command.tools, toolDecisions);
      
      console.log(`[ToolEvaluatorAgent:${this.id}] Herramientas actualizadas:`, JSON.stringify(updatedTools).substring(0, 200) + '...');
      
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
        ]
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
  private processToolEvaluationResponse(response: any, tools: any[]): any[] {
    let toolDecisions: any[] = [];

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

      // Extraer las decisiones de herramientas
      if (response && response.tool_decisions && Array.isArray(response.tool_decisions)) {
        toolDecisions = response.tool_decisions;
      } else {
        console.warn('[ToolEvaluatorAgent] Respuesta inesperada:', response);
        // Crear decisiones por defecto (no usar ninguna herramienta)
        toolDecisions = tools.map(tool => ({
          tool_name: tool.name,
          should_use: false,
          reasoning: "Default decision due to unexpected response format"
        }));
      }
    } catch (error) {
      console.error('[ToolEvaluatorAgent] Error procesando respuesta:', error);
      // Crear decisiones por defecto en caso de error
      toolDecisions = tools.map(tool => ({
        tool_name: tool.name,
        should_use: false,
        reasoning: "Error processing response"
      }));
    }

    return toolDecisions;
  }

  /**
   * Actualiza el estado de las herramientas según las decisiones
   */
  private updateToolsStatus(tools: any[], decisions: any[]): any[] {
    return tools.map(tool => {
      // Buscar la decisión para esta herramienta
      const decision = decisions.find(d => d.tool_name === tool.name);
      
      if (!decision) {
        // No hay decisión para esta herramienta, mantener como está
        return tool;
      }

      // Actualizar herramienta según la decisión
      const updatedTool = { ...tool };
      
      if (decision.should_use) {
        updatedTool.status = 'ready'; // Listo para ser ejecutado
        
        // Actualizar parámetros si se proporcionaron
        if (decision.parameters) {
          updatedTool.parameters = {
            ...updatedTool.parameters,
            ...decision.parameters
          };
        }
      } else {
        updatedTool.status = 'skipped'; // Omitir esta herramienta
      }
      
      // Guardar el razonamiento
      updatedTool.evaluation = {
        should_use: decision.should_use,
        reasoning: decision.reasoning
      };
      
      return updatedTool;
    });
  }
} 