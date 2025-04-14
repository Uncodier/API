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
  private maxRetries: number = 3; // Maximum number of retries for validation failures

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

      // Basic debug logging for targets structure
      try {
        for (const target of command.targets) {
          const targetType = target.type || Object.keys(target)[0];
          console.log(`[TargetProcessorAgent:${this.id}] Target type: ${targetType}`);
          console.log(`[TargetProcessorAgent:${this.id}] Target structure: ${JSON.stringify(target).substring(0, 100)}...`);
        }
      } catch (e) {
        console.warn(`[TargetProcessorAgent:${this.id}] Error in debug logging:`, e);
      }

      let targetResults: any[] = [];
      let bestTargetResults: any[] = []; // Store the best results we've seen so far
      let retryCount = 0;
      let isValidStructure = false;
      let updatedInputTokens = 0;
      let updatedOutputTokens = 0;
      
      // Intentar procesar los targets hasta que la estructura sea válida o se alcance el máximo de intentos
      while (!isValidStructure && retryCount < this.maxRetries) {
        if (retryCount > 0) {
          console.log(`[TargetProcessorAgent:${this.id}] Reintento ${retryCount} de ${this.maxRetries} para procesar targets`);
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
            content: formatTargetProcessorPrompt(userContext, command.targets)
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
        const portkeyResponse = await this.connector.callAgent(messages, modelOptions);
        
        // Extraer información de tokens
        const portkeyUsage = this.extractTokenUsage(portkeyResponse);
        
        // Acumular con los valores existentes en el comando
        const currentInputTokens = Number(command.input_tokens || 0);
        const currentOutputTokens = Number(command.output_tokens || 0);
        
        updatedInputTokens = currentInputTokens + (portkeyUsage.inputTokens || 0);
        updatedOutputTokens = currentOutputTokens + (portkeyUsage.outputTokens || 0);
        
        console.log(`[TargetProcessorAgent:${this.id}] Tokens acumulados - Input: ${updatedInputTokens} (${currentInputTokens} + ${portkeyUsage.inputTokens}), Output: ${updatedOutputTokens} (${currentOutputTokens} + ${portkeyUsage.outputTokens})`);
        
        // Extraer la respuesta del texto o objeto
        const response = typeof portkeyResponse === 'object' && portkeyResponse.content 
          ? portkeyResponse.content 
          : portkeyResponse;
        
        console.log(`[TargetProcessorAgent:${this.id}] Respuesta recibida:`, 
          typeof response === 'string' ? response.substring(0, 100) + '...' : JSON.stringify(response).substring(0, 100) + '...'
        );
        
        // Procesar la respuesta
        targetResults = this.processTargetResponse(response, command.targets);
        
        console.log(`[TargetProcessorAgent:${this.id}] Targets procesados:`, JSON.stringify(targetResults));
        
        // Validar la estructura de los resultados
        isValidStructure = this.validateResultsStructure(targetResults, command.targets);
        
        // Store the best results so far - even if they're not perfect
        // We'll define "best" as either:
        // 1. The first set of processed results (better than nothing)
        // 2. Any results that have MORE valid structure than our previous best
        if (bestTargetResults.length === 0 || 
            (targetResults.length > 0 && !isValidStructure)) {
          // Store a deep copy to avoid reference issues
          bestTargetResults = JSON.parse(JSON.stringify(targetResults));
        }
        
        if (!isValidStructure) {
          console.warn(`[TargetProcessorAgent:${this.id}] Estructura de resultados inválida, reintentando...`);
          retryCount++;
        }
      }
      
      // Crear una copia del comando con los tokens actualizados
      const updatedCommand = {
        ...command,
        input_tokens: updatedInputTokens,
        output_tokens: updatedOutputTokens
      };
      
      // Si después de los reintentos la estructura sigue siendo inválida, intentar reparar
      if (!isValidStructure) {
        console.warn(`[TargetProcessorAgent:${this.id}] No se pudo obtener una estructura válida después de ${this.maxRetries} intentos`);
        
        // Crear resultados por defecto para devolver
        const defaultResults = this.createDefaultResults(command.targets || []);
        
        // En caso de error en la estructura, usar resultados por defecto pero continuar el flujo
        return {
          status: 'completed',
          results: defaultResults,
          updatedCommand,
          warning: `Target processing had structure issues after ${this.maxRetries} attempts. Proceeding with default results.`
        };
      }
      
      // Devolver los resultados válidos
      return {
        status: 'completed',
        results: targetResults,
        updatedCommand
      };
    } catch (error: any) {
      console.error(`[TargetProcessorAgent:${this.id}] Error procesando targets:`, error);
      
      // En caso de error devolver status 'completed' con un mensaje de advertencia
      // y los resultados por defecto para permitir continuar el flujo
      return {
        status: 'completed',
        results: this.createDefaultResults(command.targets || []),
        warning: `Error processing targets but proceeding with default values: ${error.message}`
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
      console.warn(`[TargetProcessorAgent] Error extrayendo información de uso de tokens:`, error);
    }
    
    console.log(`[TargetProcessorAgent] Tokens detectados - Input: ${usage.inputTokens}, Output: ${usage.outputTokens}`);
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
   * Helper method to detect placeholder content in templates vs real content
   * @param targetContent The target content to check for placeholder patterns
   * @param resultContent The result content to verify against placeholders
   * @returns true if result passes content validation, false otherwise
   */
  private validateContentQuality(targetContent: any, resultContent: any): boolean {
    // Skip all content validation and just return true
    // We're removing all specific business logic validation
    return true;
  }
  
  /**
   * Generate a simple hash for string comparison
   */
  private getMd5Hash(str: string): string {
    // Simple implementation since we don't have crypto in this context
    let hash = 0;
    if (str.length === 0) return hash.toString(16);
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  // Replace the old method with the new validation approach
  private detectPlaceholderContent(targetContent: any, resultContent: any): boolean {
    // Removing specific validation logic
    return false;
  }

  /**
   * Procesa la respuesta de los targets
   */
  private processTargetResponse(response: any, targets: any[]): any[] {
    try {
      // Check if the target is expecting a string
      const isTargetString = targets.length > 0 && 
        (typeof targets[0].content === 'string' || 
         (targets[0].type && typeof targets[0][targets[0].type] === 'string'));
      
      // If response is a string and target expects a string, return it directly
      if (typeof response === 'string' && isTargetString) {
        return targets.map(target => {
          const targetType = target.type || Object.keys(target)[0];
          return {
            type: targetType,
            content: response
          };
        });
      }
      
      // If response is a string and target expects JSON, try to parse it
      if (typeof response === 'string' && !isTargetString) {
        try {
          response = JSON.parse(response);
        } catch (e) {
          console.warn('[TargetProcessorAgent] Failed to parse response as JSON:', e);
        }
      }

      // Log target and response structure for debugging
      console.log('[TargetProcessorAgent] Target structure:', JSON.stringify(targets[0], null, 2).substring(0, 200) + '...');
      console.log('[TargetProcessorAgent] Response structure:', 
        typeof response === 'string' 
          ? response.substring(0, 200) + '...' 
          : JSON.stringify(response, null, 2).substring(0, 200) + '...'
      );

      // No transformation - strict validation only
      if (Array.isArray(response) && response.length === targets.length) {
        // Validate with our strict validation
        const isValid = this.validateResultsStructure(response, targets);
        if (isValid) {
          return response;
        } else {
          console.warn('[TargetProcessorAgent] Response failed strict validation, falling back to default results');
          return this.createDefaultResults(targets);
        }
      }
      
      // If direct usage failed, fall back to manual mapping
      return targets.map((target, index) => {
        const targetType = target.type || Object.keys(target)[0];
        
        // Try to extract content from response that matches this target
        let content;
        
        if (Array.isArray(response) && index < response.length) {
          // If we have an array response, use the matching index item
          content = response[index].content || response[index];
        } else if (!Array.isArray(response) && index === 0) {
          // For non-array responses, use entire response for first target
          content = response;
        } else {
          // For additional targets without matching response data
          content = "No content provided for this target";
        }
        
        // Special handling for array content to ensure structure alignment
        if (targetType === 'contents' && Array.isArray(target.content)) {
          // Basic structure preservation - ensure array structure is maintained
          if (!Array.isArray(content)) {
            content = [content]; // Wrap non-array content in array to preserve structure
            console.log('[TargetProcessorAgent] Content wrapped in array to preserve structure');
          }
          
          return {
            type: 'contents',
            contents: content // Use 'contents' property name to match target
          };
        }
        
        // For content arrays in general, preserve array structure if target has array
        if (Array.isArray(target.content) && !Array.isArray(content)) {
          content = [content]; // Wrap non-array content in array to preserve structure
          console.log('[TargetProcessorAgent] Content wrapped in array to preserve structure');
        }
        
        // Return result with exact same structure as target
        return {
          type: targetType,
          content: content
        };
      });
      
    } catch (error) {
      console.error('[TargetProcessorAgent] Error processing response:', error);
      return this.createDefaultResults(targets);
    }
  }

  /**
   * Valida que la estructura de los resultados coincida con la estructura de los targets
   * @param results Resultados procesados
   * @param targets Targets originales
   * @returns true si la estructura es válida, false en caso contrario
   */
  private validateResultsStructure(results: any[], targets: any[]): boolean {
    if (!Array.isArray(results) || !Array.isArray(targets)) {
      console.warn('[TargetProcessorAgent] Los resultados o targets no son arrays');
      return false;
    }

    // Verificar que la longitud de los arrays coincida
    if (results.length !== targets.length) {
      console.warn(`[TargetProcessorAgent] La longitud de los resultados (${results.length}) no coincide con la longitud de los targets (${targets.length})`);
      return false;
    }

    console.log(`[TargetProcessorAgent] Validating ${results.length} results against ${targets.length} targets`);

    // Comparar cada resultado con su target correspondiente
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const result = results[i];
      
      // Simple structural validation - only check top-level properties match
      const targetKeys = Object.keys(target);
      const resultKeys = Object.keys(result);
      
      console.log(`[TargetProcessorAgent] Target keys: ${targetKeys.join(', ')}`);
      console.log(`[TargetProcessorAgent] Result keys: ${resultKeys.join(', ')}`);
      
      // Require exact top-level property match - all properties must be the same
      for (const key of targetKeys) {
        if (!resultKeys.includes(key)) {
          console.warn(`[TargetProcessorAgent] La estructura no coincide - falta la propiedad "${key}" en el resultado`);
          return false;
        }
      }
      
      for (const key of resultKeys) {
        if (!targetKeys.includes(key)) {
          console.warn(`[TargetProcessorAgent] La estructura no coincide - la propiedad "${key}" en el resultado no existe en el target`);
          return false;
        }
      }
      
      // Verify basic type matching for each property
      for (const key of targetKeys) {
        const targetValue = target[key];
        const resultValue = result[key];
        
        // Only check type matching between primitive types or arrays
        if (Array.isArray(targetValue) !== Array.isArray(resultValue)) {
          console.warn(`[TargetProcessorAgent] La estructura de la propiedad "${key}" no coincide: uno es array y el otro no`);
          return false;
        }
        
        // If not arrays, check that primitive types match
        if (!Array.isArray(targetValue) && typeof targetValue !== typeof resultValue) {
          console.warn(`[TargetProcessorAgent] El tipo de la propiedad "${key}" no coincide: target=${typeof targetValue}, result=${typeof resultValue}`);
          return false;
        }
      }
    }

    console.log('[TargetProcessorAgent] All structure validations passed successfully');
    return true;
  }

  /**
   * Find the property path to the content in an object
   * This addresses the key issue where we had "contents" vs "content"
   */
  private findContentPropertyPath(obj: any): string {
    // Check for direct properties
    if (obj.content) return 'content';
    if (obj.contents) return 'contents';
    
    // Check for nested content under type
    if (obj.type && obj[obj.type]) {
      return obj.type;
    }
    
    // Look for any array property that might be content
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key])) {
        return key;
      }
    }
    
    return '';
  }
  
  /**
   * Get a property value by path string
   */
  private getPropertyByPath(obj: any, path: string): any {
    if (!path) return null;
    return obj[path];
  }

  /**
   * Validate if a response array directly matches the target structure
   * @param response Response array to validate
   * @param targets Target array to validate against
   * @returns true if structure matches, false otherwise
   */
  private validateResponseStructure(response: any[], targets: any[]): boolean {
    // Just delegate to the main validation function
    return this.validateResultsStructure(response, targets);
  }

  /**
   * Compara las propiedades de dos objetos para verificar que coincidan
   * @param target Objeto target
   * @param result Objeto resultado
   * @returns true si las propiedades coinciden, false en caso contrario
   */
  private compareProperties(target: any, result: any): boolean {
    // Manejar caso especial para null o undefined
    if (target === null || result === null) {
      return target === result;
    }
    
    // Verificar si estamos comparando objetos
    if (typeof target !== 'object' || typeof result !== 'object') {
      return typeof target === typeof result;
    }
    
    // Obtener las claves de ambos objetos
    const targetKeys = Object.keys(target);
    const resultKeys = Object.keys(result);
    
    // Para objetos normales, verificación completa
    // Verificar que todas las claves del target estén en el resultado
    for (const key of targetKeys) {
      if (!resultKeys.includes(key)) {
        console.warn(`[TargetProcessorAgent] Falta la propiedad "${key}" en el resultado`);
        return false;
      }
    }
    
    // Verificar que todas las claves del resultado estén en el target
    for (const key of resultKeys) {
      if (!targetKeys.includes(key)) {
        console.warn(`[TargetProcessorAgent] La propiedad "${key}" en el resultado no existe en el target`);
        return false;
      }
    }
    
    // Verificar los tipos de las propiedades para asegurar compatibilidad estructural
    for (const key of targetKeys) {
      const targetValue = target[key];
      const resultValue = result[key];
      
      // Si son objetos, comparar recursivamente
      if (typeof targetValue === 'object' && targetValue !== null && 
          typeof resultValue === 'object' && resultValue !== null) {
        if (Array.isArray(targetValue) !== Array.isArray(resultValue)) {
          console.warn(`[TargetProcessorAgent] La estructura de la propiedad "${key}" no coincide: uno es array y el otro no`);
          return false;
        }
        
        if (Array.isArray(targetValue) && Array.isArray(resultValue)) {
          // Solo verificar longitud para arrays
          if (targetValue.length !== resultValue.length) {
            console.warn(`[TargetProcessorAgent] La longitud del array "${key}" no coincide: target=${targetValue.length}, result=${resultValue.length}`);
            return false;
          }
        } else {
          // Para objetos, comparar recursivamente
          if (!this.compareProperties(targetValue, resultValue)) {
            return false;
          }
        }
      }
      // Si son de tipos diferentes, fallar
      else if (typeof targetValue !== typeof resultValue) {
        console.warn(`[TargetProcessorAgent] Los tipos de la propiedad "${key}" no coinciden: target=${typeof targetValue}, result=${typeof resultValue}`);
        return false;
      }
    }
    
    return true;
  }

  /**
   * Crea resultados por defecto para los targets
   * @param targets Targets originales
   * @returns Array de resultados por defecto
   */
  private createDefaultResults(targets: any[]): any[] {
    return targets.map(target => {
      // Check if target has a "type" field directly
      if (target.type) {
        return {
          type: target.type,
          content: "Could not process target due to unexpected response format"
        };
      }
      // Fall back to the old approach
      const targetType = Object.keys(target)[0];
      return {
        type: targetType,
        content: "Could not process target due to unexpected response format"
      };
    });
  }
} 