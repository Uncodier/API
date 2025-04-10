/**
 * TargetProcessorAgent - Agente especializado para procesar los targets del comando
 * después de la evaluación de herramientas.
 */
import { BaseAgent } from './BaseAgent';
import { PortkeyAgentConnector } from '../services/PortkeyAgentConnector';
import { DbCommand, CommandExecutionResult, PortkeyModelOptions, ToolExecutionResult } from '../models/types';
import { TARGET_PROCESSOR_SYSTEM_PROMPT, formatTargetProcessorPrompt } from '../prompts/target-processor-prompt';

export class TargetProcessorAgent extends BaseAgent {
  private connector: PortkeyAgentConnector;
  private defaultOptions: Partial<PortkeyModelOptions>;

  constructor(
    id: string, 
    name: string, 
    connector: PortkeyAgentConnector,
    capabilities: string[] = ['target_processing'],
    defaultOptions?: Partial<PortkeyModelOptions>
  ) {
    super(id, name, capabilities);
    this.connector = connector;
    this.defaultOptions = defaultOptions || {};
  }

  /**
   * Procesa los targets del comando basado en la evaluación de herramientas
   */
  async executeCommand(command: DbCommand): Promise<CommandExecutionResult> {
    try {
      console.log(`[TargetProcessorAgent:${this.id}] Procesando targets para el comando: ${command.id}`);
      
      // Verificar si hay targets para procesar
      if (!command.targets || command.targets.length === 0) {
        console.log(`[TargetProcessorAgent:${this.id}] No hay targets para procesar`);
        return {
          status: 'completed',
          results: [{
            type: 'target_processing',
            content: { message: "No targets to process" }
          }]
        };
      }

      // Obtener información de herramientas evaluadas (si existe)
      const toolEvaluationResult = command.results?.find(result => 
        result.type === 'tool_evaluation' && result.content?.updated_tools
      );
      
      let evaluatedTools: any[] = [];
      if (toolEvaluationResult) {
        evaluatedTools = toolEvaluationResult.content.updated_tools || [];
      } else if (command.tools) {
        evaluatedTools = command.tools;
      }
      
      // Usar el contexto completo del comando sin extraer nada
      const userContext = command.context || '';
      
      // Preparar los mensajes para el LLM usando las plantillas de prompt
      const messages = [
        {
          role: 'system' as const,
          content: TARGET_PROCESSOR_SYSTEM_PROMPT
        },
        {
          role: 'user' as const,
          content: formatTargetProcessorPrompt(userContext, command.targets, evaluatedTools)
        }
      ];
      
      // Configurar opciones del modelo
      const modelOptions: PortkeyModelOptions = {
        modelType: command.model_type || this.defaultOptions.modelType || 'anthropic',
        modelId: command.model_id || this.defaultOptions.modelId,
        maxTokens: command.max_tokens || this.defaultOptions.maxTokens || 1000,
        temperature: command.temperature || this.defaultOptions.temperature || 0.2,
        responseFormat: 'json'
      };
      
      console.log(`[TargetProcessorAgent:${this.id}] Enviando procesamiento al LLM`);
      
      // Enviar al LLM para procesamiento
      const response = await this.connector.callAgent(messages, modelOptions);
      
      console.log(`[TargetProcessorAgent:${this.id}] Respuesta recibida:`, 
        typeof response === 'string' ? response.substring(0, 100) + '...' : JSON.stringify(response).substring(0, 100) + '...'
      );
      
      // Procesar la respuesta
      const targetResults = this.processTargetResponse(response, command.targets);
      
      console.log(`[TargetProcessorAgent:${this.id}] Targets procesados:`, JSON.stringify(targetResults));
      
      // Devolver los resultados
      return {
        status: 'completed',
        results: targetResults
      };
    } catch (error: any) {
      console.error(`[TargetProcessorAgent:${this.id}] Error procesando targets:`, error);
      
      return {
        status: 'failed',
        error: `Error processing targets: ${error.message}`
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
   * Procesa la respuesta de los targets
   */
  private processTargetResponse(response: any, targets: any[]): any[] {
    let targetResults: any[] = [];

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

      // Si la respuesta es un array, usarlo directamente
      if (Array.isArray(response)) {
        targetResults = response;
      } 
      // Si la respuesta es un objeto JSON con una propiedad que es un array
      else if (response && typeof response === 'object') {
        // Buscar una propiedad que sea un array
        const arrayProp = Object.keys(response).find(key => Array.isArray(response[key]));
        if (arrayProp) {
          targetResults = response[arrayProp];
        } else {
          // Si no hay un array, intentar convertir el objeto en un array de resultados
          targetResults = [{ type: 'result', content: response }];
        }
      } 
      // Si es una cadena de texto, crear un resultado de tipo mensaje
      else if (typeof response === 'string') {
        targetResults = [{ type: 'message', content: response }];
      }
      // Si no se pudo procesar, crear resultados por defecto
      else {
        console.warn('[TargetProcessorAgent] Respuesta inesperada:', response);
        targetResults = targets.map(target => {
          const targetType = Object.keys(target)[0];
          return {
            type: targetType,
            content: "Could not process target due to unexpected response format"
          };
        });
      }
      
      // Asegurarse de que todos los targets tienen un resultado
      this.ensureAllTargetsHaveResults(targetResults, targets);
      
    } catch (error) {
      console.error('[TargetProcessorAgent] Error procesando respuesta:', error);
      // Crear resultados por defecto en caso de error
      targetResults = targets.map(target => {
        const targetType = Object.keys(target)[0];
        return {
          type: targetType,
          content: "Error processing target"
        };
      });
    }

    return targetResults;
  }

  /**
   * Asegura que todos los targets tienen un resultado
   */
  private ensureAllTargetsHaveResults(results: any[], targets: any[]): void {
    // Crear un mapa de tipos de target para verificar cuáles faltan
    const targetTypes = targets.map(target => Object.keys(target)[0]);
    const resultTypes = results.map(result => result.type);
    
    // Verificar si falta algún tipo de target en los resultados
    for (const targetType of targetTypes) {
      if (!resultTypes.includes(targetType)) {
        // Agregar un resultado por defecto para este tipo
        results.push({
          type: targetType,
          content: `Default content for ${targetType}`
        });
      }
    }
  }
} 