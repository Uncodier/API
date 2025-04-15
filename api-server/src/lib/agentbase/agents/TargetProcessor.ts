/**
 * TargetProcessor - Procesador especializado para generar respuestas
 * basadas en el contexto del usuario y los resultados de herramientas.
 */
import { Base } from './Base';
import { PortkeyConnector } from '../services/PortkeyConnector';
import { DbCommand, CommandExecutionResult, PortkeyModelOptions, ToolExecutionResult } from '../models/types';
import { TARGET_PROCESSOR_SYSTEM_PROMPT, formatTargetProcessorPrompt } from '../prompts/target-processor-prompt';

export class TargetProcessor extends Base {
  private connector: PortkeyConnector;
  private defaultOptions: Partial<PortkeyModelOptions>;
  private maxRetries: number = 3; // Maximum number of retries for validation failures
  // Propiedades adicionales del agente
  readonly description?: string;
  readonly systemPrompt?: string;

  constructor(
    id: string, 
    name: string, 
    connector: PortkeyConnector,
    capabilities: string[] = ['target_processing'],
    defaultOptions?: Partial<PortkeyModelOptions>,
    description?: string,
    systemPrompt?: string
  ) {
    super(id, name, capabilities);
    this.connector = connector;
    this.defaultOptions = defaultOptions || {};
    this.description = description;
    this.systemPrompt = systemPrompt;
    
    // Loguear para depuración
    if (this.description) console.log(`📝 [TargetProcessor] Descripción: ${this.description.substring(0, 100)}...`);
    if (this.systemPrompt) console.log(`🧠 [TargetProcessor] System Prompt: ${this.systemPrompt.substring(0, 100)}...`);
  }

  /**
   * Procesa los targets del comando basado en la evaluación de herramientas
   */
  async executeCommand(command: DbCommand): Promise<CommandExecutionResult> {
    console.log(`[TargetProcessor] Procesando targets para el comando: ${command.id}`);
    
    // Inicializar variables
    let targetResults: any[] = [];
    let bestTargetResults: any[] = [];
    let isValidStructure = false;
    let retryCount = 0;
    let updatedInputTokens = 0;
    let updatedOutputTokens = 0;
    let usedModel = ""; // Añadido para guardar el modelo usado
    
    try {
      // Validar que existan targets para procesar
      if (!command.targets || command.targets.length === 0) {
        console.log(`[TargetProcessor] No hay targets para procesar en el comando ${command.id}`);
        return {
          status: 'completed',
          results: [],
          warning: 'No targets provided'
        };
      }
      
      // Logging de los tipos de targets
      command.targets.forEach(target => {
        const targetType = target.type || Object.keys(target)[0];
        console.log(`[TargetProcessor] Target type: ${targetType}`);
        console.log(`[TargetProcessor] Target structure: ${JSON.stringify(target, null, 2).substring(0, 100)}...`);
      });
      
      // Intentar hasta obtener una estructura válida o alcanzar máximo de reintentos
      while (!isValidStructure && retryCount < this.maxRetries) {
        // Construir contexto para el LLM
        const userContext = command.context || "No context provided";
        
        // Preparar mensajes para el LLM
        const messages: any[] = [];
        
        // Agregar mensaje de sistema (puede ser system prompt o agent background)
        if (command.agent_background) {
          console.log(`🧠 [TargetProcessor] agent_background encontrado, usando como mensaje de sistema`);
          console.log(`🧠 [TargetProcessor] Contenido completo del agent_background:`);
          console.log(command.agent_background);
          
          messages.push({
            role: 'system',
            content: command.agent_background
          });
          
          console.log(`📝 [TargetProcessor] Mensaje de sistema establecido con agent_background`);
        } else if (this.systemPrompt) {
          messages.push({
            role: 'system',
            content: this.systemPrompt
          });
          
          console.log(`📝 [TargetProcessor] Mensaje de sistema establecido con prompt por defecto`);
        }
        
        messages.push({
          role: 'user',
          content: formatTargetProcessorPrompt(userContext, command.targets)
        });
        
        // Configurar opciones del modelo
        const modelOptions: PortkeyModelOptions = {
          modelType: command.model_type || this.defaultOptions.modelType || 'openai',
          modelId: command.model_id || this.defaultOptions.modelId || 'gpt-4o',
          maxTokens: command.max_tokens || this.defaultOptions.maxTokens || 1000,
          temperature: command.temperature || this.defaultOptions.temperature || 0.2,
          responseFormat: 'json'
        };
        
        console.log(`[TargetProcessor] Enviando procesamiento al LLM`);
        
        try {
          // Enviar al LLM para procesamiento
          const portkeyResponse = await this.connector.callAgent(messages, modelOptions);
          
          // Extraer el modelo usado de la respuesta si está disponible
          if (portkeyResponse.modelInfo) {
            usedModel = portkeyResponse.modelInfo.model;
            console.log(`[TargetProcessor] Modelo utilizado en la llamada: ${usedModel}`);
          } else {
            // Si no está disponible en la respuesta, usar el que configuramos
            usedModel = modelOptions.modelId || this.defaultOptions.modelId || 'gpt-4o';
            console.log(`[TargetProcessor] Usando modelo configurado: ${usedModel}`);
          }
          
          // Extraer información de tokens
          const portkeyUsage = this.extractTokenUsage(portkeyResponse);
          
          // Acumular con los valores existentes en el comando
          const currentInputTokens = Number(command.input_tokens || 0);
          const currentOutputTokens = Number(command.output_tokens || 0);
          
          updatedInputTokens = currentInputTokens + (portkeyUsage.inputTokens || 0);
          updatedOutputTokens = currentOutputTokens + (portkeyUsage.outputTokens || 0);
          
          console.log(`[TargetProcessor] Tokens acumulados - Input: ${updatedInputTokens} (${currentInputTokens} + ${portkeyUsage.inputTokens}), Output: ${updatedOutputTokens} (${currentOutputTokens} + ${portkeyUsage.outputTokens})`);
          
          // Extraer la respuesta del texto o objeto
          const response = typeof portkeyResponse === 'object' && portkeyResponse.content 
            ? portkeyResponse.content 
            : portkeyResponse;
          
          console.log(`[TargetProcessor] Respuesta recibida:`, 
            typeof response === 'string' 
              ? response.substring(0, 100) + '...' 
              : JSON.stringify(response).substring(0, 100) + '...'
          );
          
          // Procesar la respuesta
          targetResults = this.processTargetResponse(response, command.targets);
          
          console.log(`[TargetProcessor] Targets procesados:`, JSON.stringify(targetResults));
          
          // Validar la estructura de los resultados
          isValidStructure = this.validateResultsStructure(targetResults, command.targets);
          
          // Store the best results so far - even if they're not perfect
          if (bestTargetResults.length === 0 || 
              (targetResults.length > 0 && !isValidStructure)) {
            // Store a deep copy to avoid reference issues
            bestTargetResults = JSON.parse(JSON.stringify(targetResults));
          }
          
          if (!isValidStructure) {
            console.warn(`[TargetProcessor] Estructura de resultados inválida, reintentando...`);
            retryCount++;
          }
        } catch (error: any) {
          console.error(`[TargetProcessor] Error al llamar al LLM:`, error);
          retryCount++;
          
          // Si es el último intento, crear resultados por defecto adaptados a los targets
          if (retryCount >= this.maxRetries) {
            // Intentar crear respuestas basadas exactamente en la estructura de los targets
            targetResults = command.targets.map(target => {
              // Si es una estructura como { "message": { ... } }
              const targetKeys = Object.keys(target);
              if (targetKeys.length === 1 && typeof target[targetKeys[0]] === 'object') {
                // Mantener la estructura exacta del target
                const key = targetKeys[0];
                return {
                  [key]: {
                    content: "No se pudo obtener una respuesta. Por favor, inténtelo de nuevo más tarde."
                  }
                };
              }
              
              // Si el target tiene un tipo explícito
              if (target.type) {
                return {
                  type: target.type,
                  content: "No se pudo obtener una respuesta. Por favor, inténtelo de nuevo más tarde."
                };
              }
              
              // Caso de fallback
              return {
                ...target,
                content: "No se pudo obtener una respuesta. Por favor, inténtelo de nuevo más tarde."
              };
            });
            
            // Verificar si esta estructura es válida
            isValidStructure = this.validateResultsStructure(targetResults, command.targets);
            if (!isValidStructure) {
              // Si no es válida, usar el método tradicional
              targetResults = this.createDefaultResults(command.targets || []);
            }
          }
        }
      }
      
      // Crear una copia del comando con los tokens actualizados y el modelo usado
      const updatedCommand = {
        ...command,
        input_tokens: updatedInputTokens,
        output_tokens: updatedOutputTokens,
        model: usedModel
      };
      
      console.log(`[TargetProcessor] Actualizando comando con modelo: ${usedModel}`);
      
      // Si después de los reintentos la estructura sigue siendo inválida, usar los mejores resultados o resultados por defecto
      if (!isValidStructure) {
        console.warn(`[TargetProcessor] No se pudo obtener una estructura válida después de ${this.maxRetries} intentos`);
        
        // Verificar si tenemos al menos algunos resultados parciales almacenados
        if (bestTargetResults.length > 0) {
          console.log(`[TargetProcessor] Usando los mejores resultados parciales obtenidos`);
          targetResults = bestTargetResults;
        } else {
          // Crear resultados por defecto para devolver
          targetResults = this.createDefaultResults(command.targets || []);
        }
        
        return {
          status: 'completed',
          results: targetResults,
          updatedCommand,
          warning: `Target processing had structure issues after ${this.maxRetries} attempts. Proceeding with best effort results.`,
          inputTokens: updatedInputTokens,
          outputTokens: updatedOutputTokens
        };
      }
      
      // Devolver los resultados válidos
      return {
        status: 'completed',
        results: targetResults,
        updatedCommand,
        inputTokens: updatedInputTokens,
        outputTokens: updatedOutputTokens
      };
    } catch (error: any) {
      console.error(`[TargetProcessor] Error procesando targets:`, error);
      
      // En caso de error devolver status 'completed' con un mensaje de advertencia
      // y los resultados por defecto para permitir continuar el flujo
      return {
        status: 'completed',
        results: this.createDefaultResults(command.targets || []),
        warning: `Error processing targets but proceeding with default values: ${error.message}`,
        inputTokens: 0,
        outputTokens: 0
      };
    }
  }

  /**
   * Extrae la información de uso de tokens de la respuesta de Portkey
   */
  protected extractTokenUsage(response: any): { inputTokens: number, outputTokens: number } {
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
      console.warn(`[TargetProcessor] Error extrayendo información de uso de tokens:`, error);
    }
    
    console.log(`[TargetProcessor] Tokens detectados - Input: ${usage.inputTokens}, Output: ${usage.outputTokens}`);
    return usage;
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
          console.warn('[TargetProcessor] Failed to parse response as JSON:', e);
        }
      }

      // Log target and response structure for debugging
      console.log('[TargetProcessor] Target structure:', JSON.stringify(targets[0], null, 2).substring(0, 200) + '...');
      console.log('[TargetProcessor] Response structure:', 
        typeof response === 'string' 
          ? response.substring(0, 200) + '...' 
          : JSON.stringify(response, null, 2).substring(0, 200) + '...'
      );

      // Direct structure match check - if response already matches target structure exactly
      if (!Array.isArray(response) && targets.length === 1) {
        const targetKeys = Object.keys(targets[0]);
        const responseKeys = Object.keys(response);
        
        // Check for direct structure match
        const structureMatches = targetKeys.every(key => responseKeys.includes(key)) && 
                                 responseKeys.every(key => targetKeys.includes(key));
        
        if (structureMatches) {
          console.log('[TargetProcessor] Direct structure match detected, using response as-is');
          return [response];
        }
      }

      // No transformation - strict validation only
      if (Array.isArray(response) && response.length === targets.length) {
        // Validate with our strict validation
        const isValid = this.validateResultsStructure(response, targets);
        if (isValid) {
          return response;
        } else {
          console.warn('[TargetProcessor] Response failed strict validation, falling back to default results');
          return this.createDefaultResults(targets);
        }
      }
      
      // If direct usage failed, fall back to manual mapping
      return targets.map((target, index) => {
        // Get the first key in the target object - for special handling
        const targetKeys = Object.keys(target);
        
        // Special handling for objects like { "message": { ... } }
        if (targetKeys.length === 1 && typeof target[targetKeys[0]] === 'object') {
          const key = targetKeys[0];
          
          // Direct pass-through for matched structure from the LLM
          if (!Array.isArray(response)) {
            // If LLM already returned the correct structure with the key, use it directly
            if (response[key]) {
              console.log(`[TargetProcessor] Found exact structure match for key "${key}", using directly`);
              return { [key]: response[key] };
            }
          }
        }

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
          content = "No se pudo obtener una respuesta. Por favor, inténtelo de nuevo más tarde.";
        }
        
        // Special handling for array content to ensure structure alignment
        if (targetType === 'contents' && Array.isArray(target.content)) {
          // Basic structure preservation - ensure array structure is maintained
          if (!Array.isArray(content)) {
            content = [content]; // Wrap non-array content in array to preserve structure
            console.log('[TargetProcessor] Content wrapped in array to preserve structure');
          }
          
          return {
            type: 'contents',
            contents: content // Use 'contents' property name to match target
          };
        }
        
        // For content arrays in general, preserve array structure if target has array
        if (Array.isArray(target.content) && !Array.isArray(content)) {
          content = [content]; // Wrap non-array content in array to preserve structure
          console.log('[TargetProcessor] Content wrapped in array to preserve structure');
        }
        
        // Return result with exact same structure as target
        return {
          type: targetType,
          content: content
        };
      });
      
    } catch (error) {
      console.error('[TargetProcessor] Error processing response:', error);
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
      console.warn('[TargetProcessor] Los resultados o targets no son arrays');
      return false;
    }

    // Verificar que la longitud de los arrays coincida
    if (results.length !== targets.length) {
      console.warn(`[TargetProcessor] La longitud de los resultados (${results.length}) no coincide con la longitud de los targets (${targets.length})`);
      return false;
    }

    console.log(`[TargetProcessor] Validating ${results.length} results against ${targets.length} targets`);

    // Comparar cada resultado con su target correspondiente
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const result = results[i];
      
      // Simple structural validation - only check top-level properties match
      const targetKeys = Object.keys(target);
      const resultKeys = Object.keys(result);
      
      console.log(`[TargetProcessor] Target keys: ${targetKeys.join(', ')}`);
      console.log(`[TargetProcessor] Result keys: ${resultKeys.join(', ')}`);
      
      // Special handling for exact matches: If target has only one object property like {"message": {...}}
      if (targetKeys.length === 1 && typeof target[targetKeys[0]] === 'object') {
        const key = targetKeys[0];
        
        // Check if result has the same key
        if (result[key]) {
          console.log(`[TargetProcessor] Direct structure match detected for key "${key}"`);
          // Consider this a valid match
          continue;
        }
      }
      
      // Require exact top-level property match - all properties must be the same
      for (const key of targetKeys) {
        if (!resultKeys.includes(key)) {
          console.warn(`[TargetProcessor] La estructura no coincide - falta la propiedad "${key}" en el resultado`);
          return false;
        }
      }
      
      for (const key of resultKeys) {
        if (!targetKeys.includes(key)) {
          console.warn(`[TargetProcessor] La estructura no coincide - la propiedad "${key}" en el resultado no existe en el target`);
          return false;
        }
      }
      
      // Verify basic type matching for each property
      for (const key of targetKeys) {
        const targetValue = target[key];
        const resultValue = result[key];
        
        // Only check type matching between primitive types or arrays
        if (Array.isArray(targetValue) !== Array.isArray(resultValue)) {
          console.warn(`[TargetProcessor] La estructura de la propiedad "${key}" no coincide: uno es array y el otro no`);
          return false;
        }
        
        // If not arrays, check that primitive types match
        if (!Array.isArray(targetValue) && typeof targetValue !== typeof resultValue) {
          console.warn(`[TargetProcessor] El tipo de la propiedad "${key}" no coincide: target=${typeof targetValue}, result=${typeof resultValue}`);
          return false;
        }
      }
    }

    console.log('[TargetProcessor] All structure validations passed successfully');
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
          content: "No se pudo obtener una respuesta. Por favor, inténtelo de nuevo más tarde."
        };
      }
      
      // Get the first key in the target object
      const targetKeys = Object.keys(target);
      
      // If we have a target structure like { "message": { "content": "example" } }
      if (targetKeys.length === 1 && typeof target[targetKeys[0]] === 'object') {
        // Maintain the exact same structure as the original target
        const key = targetKeys[0];
        return {
          [key]: {
            content: "No se pudo obtener una respuesta. Por favor, inténtelo de nuevo más tarde."
          }
        };
      }
      
      // Fall back to the old approach
      return {
        type: targetKeys[0],
        content: "No se pudo obtener una respuesta. Por favor, inténtelo de nuevo más tarde."
      };
    });
  }

  /**
   * Generate a mock response for testing
   */
  private getMockResponse(messages: any[], options: any): any {
    // Simple mock response for testing
    const userMessages = messages.filter(m => m.role === 'user');
    const lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';
    
    return {
      content: `Te puedo ayudar con cualquier pregunta que tengas. ¿En qué más puedo asistirte?`,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50
      }
    };
  }
} 