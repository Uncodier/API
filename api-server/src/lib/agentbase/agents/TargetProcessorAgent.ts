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

      // Special debug logging: Check if targets contain any blog post templates
      // This is to debug the specific issue with "markdown detailed copy" templates
      try {
        for (const target of command.targets) {
          const targetType = target.type || Object.keys(target)[0];
          const content = target[targetType] || target.content;
          
          if (Array.isArray(content) && content.length > 0 && content[0].type === 'blog_post') {
            const blogPost = content[0];
            console.log(`[TargetProcessorAgent:${this.id}] DEBUG: Found blog post template`);
            console.log(`[TargetProcessorAgent:${this.id}] DEBUG: Text begins with: ${blogPost.text?.substring(0, 50) || 'undefined'}`);
            console.log(`[TargetProcessorAgent:${this.id}] DEBUG: Title: ${blogPost.title || 'undefined'}`);
            
            // Check for common template indicators
            const isTemplate = blogPost.text?.includes('detailed copy') || 
                               blogPost.title?.includes('title of the content') ||
                               blogPost.description?.includes('summary of the content');
                               
            if (isTemplate) {
              console.log(`[TargetProcessorAgent:${this.id}] DEBUG: This appears to be a TEMPLATE BLOG POST that should be replaced with real content`);
            }
          }
        }
      } catch (e) {
        console.warn(`[TargetProcessorAgent:${this.id}] Error in template debug logging:`, e);
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
    // Skip checks if not the right structure
    if (!targetContent || !resultContent || typeof targetContent !== 'object' || typeof resultContent !== 'object') {
      return true; // Can't validate these types
    }
    
    // Common placeholder texts that should not appear in actual final content
    const placeholderTexts = [
      "detailed copy", 
      "title of the content", 
      "summary of the content",
      "markdown detailed",
      "placeholder",
      "your content here",
      "lorem ipsum"
    ];
    
    // Check if target has placeholder text indicators that would suggest it's a template
    const targetIsTemplate = Object.keys(targetContent).some(key => {
      if (typeof targetContent[key] === 'string') {
        return placeholderTexts.some(placeholder => 
          targetContent[key].toLowerCase().includes(placeholder)
        );
      }
      return false;
    });
    
    // If target looks like a template and the response looks exactly the same as the target
    // this likely means the LLM just repeated our template
    if (targetIsTemplate) {
      console.log('[TargetProcessorAgent] Target appears to be a template with placeholder content');
      
      // Check for verbatim copying of fields that should be different
      if (targetContent.text && resultContent.text) {
        const targetTextMd5 = this.getMd5Hash(targetContent.text);
        const resultTextMd5 = this.getMd5Hash(resultContent.text);
        
        // If the text content is identical, that's a problem
        if (targetTextMd5 === resultTextMd5) {
          console.warn('[TargetProcessorAgent] Result text is identical to template text - LLM likely copied template');
          return false;
        }
        
        // If target has placeholder indicators but result also has the same indicators
        // then LLM probably copied placeholder patterns
        for (const placeholder of placeholderTexts) {
          if (targetContent.text.toLowerCase().includes(placeholder) && 
              resultContent.text.toLowerCase().includes(placeholder)) {
            console.warn(`[TargetProcessorAgent] Result contains placeholder text "${placeholder}" from template`);
            return false;
          }
        }
      }
      
      // Check title field for placeholder copying
      if (targetContent.title && resultContent.title && 
          targetContent.title === resultContent.title && 
          placeholderTexts.some(p => targetContent.title.toLowerCase().includes(p))) {
        console.warn('[TargetProcessorAgent] Result title identical to template placeholder title');
        return false;
      }
      
      // Check for minimum content length on text fields if target appears to be a template
      // Real content should have substantial length
      if (targetContent.text && resultContent.text) {
        const minLength = 100; // Minimum characters expected for real content
        if (resultContent.text.length < minLength && targetContent.text.includes('detailed')) {
          console.warn(`[TargetProcessorAgent] Result text too short (${resultContent.text.length} chars) to be valid content`);
          return false;
        }
      }
    }
    
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
    return !this.validateContentQuality(targetContent, resultContent);
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
        if (targetType === 'contents' && 
            Array.isArray(target.content) && 
            target.content.length > 0 && 
            typeof target.content[0] === 'object') {
          
          // Create proper structure for blog post array
          if (Array.isArray(content)) {
            // Keep array structure intact
            content = content;
          } else if (typeof content === 'object' && !Array.isArray(content)) {
            // CRITICAL FIX: Always wrap single objects in an array to maintain structure
            content = [content];
            console.log('[TargetProcessorAgent] Single object wrapped in array to preserve structure');
          } else if (typeof content === 'string') {
            // Convert string to blog post format if target expects blog post
            const targetItem = target.content[0];
            if (targetItem && targetItem.type === 'blog_post') {
              content = [{
                text: content,
                type: 'blog_post',
                title: 'Generated Blog Post',
                description: 'Generated content from string response',
                estimated_reading_time: Math.max(1, Math.floor(content.length / 1000))
              }];
            } else {
              // CRITICAL FIX: Always wrap string in array if original target is array
              content = [content];
              console.log('[TargetProcessorAgent] String wrapped in array to preserve structure');
            }
          } else {
            // Content is something unexpected, create a basic structure based on target
            content = target.content.map(() => ({ text: "Content structure could not be processed correctly" }));
          }
        }
        
        // IMPORTANT: For targets with 'contents' type, always ensure the response also uses 'contents'
        // This fixes a key issue in the test case where 'contents' in target becomes 'content' in response
        if (targetType === 'contents') {
          return {
            type: 'contents',
            contents: content // Use 'contents' property name to match target
          };
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
      
      // ENHANCED VALIDATION: Perform deep structure validation to ensure exact property path matching
      
      // Step 1: Check if top-level properties exactly match
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
      
      // Step 2: For each top-level property, verify the type and structure matches
      for (const key of targetKeys) {
        // Skip content validation, which is handled separately
        if (key === 'content') continue;
        
        const targetValue = target[key];
        const resultValue = result[key];
        
        // Verify types match
        if (typeof targetValue !== typeof resultValue) {
          console.warn(`[TargetProcessorAgent] El tipo de la propiedad "${key}" no coincide: target=${typeof targetValue}, result=${typeof resultValue}`);
          return false;
        }
        
        // If both are arrays, verify array types match
        if (Array.isArray(targetValue) !== Array.isArray(resultValue)) {
          console.warn(`[TargetProcessorAgent] La estructura de la propiedad "${key}" no coincide: uno es array y el otro no`);
          return false;
        }
      }
      
      // Step 3: Special handling for "content" property path which is critical
      // This is where the bug was - we need to verify complete paths match
      const targetContentPath = this.findContentPropertyPath(target);
      const resultContentPath = this.findContentPropertyPath(result);
      
      console.log(`[TargetProcessorAgent] Target content path: ${targetContentPath}`);
      console.log(`[TargetProcessorAgent] Result content path: ${resultContentPath}`);
      
      // Content property paths must match exactly
      if (targetContentPath !== resultContentPath) {
        console.warn(`[TargetProcessorAgent] Las rutas de la propiedad "content" no coinciden: target=${targetContentPath}, result=${resultContentPath}`);
        return false;
      }
      
      // Get the content values using the paths
      const targetContent = this.getPropertyByPath(target, targetContentPath);
      const resultContent = this.getPropertyByPath(result, resultContentPath);
      
      if (!targetContent || !resultContent) {
        console.warn(`[TargetProcessorAgent] Falta contenido en el target o en el resultado`);
        return false;
      }
      
      // Check array vs non-array
      if (Array.isArray(targetContent) !== Array.isArray(resultContent)) {
        console.warn(`[TargetProcessorAgent] Estructura no coincide: target content es ${Array.isArray(targetContent) ? 'array' : 'no-array'} pero resultado content es ${Array.isArray(resultContent) ? 'array' : 'no-array'}`);
        return false;
      }
      
      // Si ambos son arrays, verificar que tengan la misma longitud
      if (Array.isArray(targetContent) && Array.isArray(resultContent)) {
        // Solo verificar longitud para arrays vacíos o simples
        // Para arrays de objetos complejos como blog posts, necesitamos una validación más profunda
        const isComplexArray = targetContent.length > 0 && typeof targetContent[0] === 'object';
        
        console.log(`[TargetProcessorAgent] Validating array content, isComplexArray: ${isComplexArray}`);
        console.log(`[TargetProcessorAgent] Target array length: ${targetContent.length}, Result array length: ${resultContent.length}`);
        
        if (targetContent.length !== resultContent.length && !isComplexArray) {
          console.warn(`[TargetProcessorAgent] La longitud del contenido del target (${targetContent.length}) no coincide con la longitud del contenido del resultado (${resultContent.length})`);
          return false;
        }
        
        // Para arrays de objetos complejos como blog posts
        if (isComplexArray) {
          // Verificar el primer elemento si existe
          if (resultContent.length === 0) {
            console.warn('[TargetProcessorAgent] El array de contenido del resultado está vacío pero el target tiene elementos');
            return false;
          }
          
          // Verificar el primer objeto de blog post u otro objeto complejo
          const targetItem = targetContent[0];
          const resultItem = resultContent[0];
          
          console.log(`[TargetProcessorAgent] Target item type: ${targetItem.type || 'unknown'}`);
          console.log(`[TargetProcessorAgent] Target text preview: ${typeof targetItem.text === 'string' ? targetItem.text.substring(0, 50) + '...' : 'not string'}`);
          console.log(`[TargetProcessorAgent] Result text preview: ${typeof resultItem.text === 'string' ? resultItem.text.substring(0, 50) + '...' : 'not string'}`);
          
          // Verificar que es un objeto
          if (typeof resultItem !== 'object') {
            console.warn(`[TargetProcessorAgent] El primer elemento del contenido no es un objeto: ${typeof resultItem}`);
            return false;
          }
          
          // NEW: Check if target is a template with placeholders and result isn't significantly different
          // This is the critical check for blog post content
          if (targetItem.type === 'blog_post') {
            console.log('[TargetProcessorAgent] Detected blog post, performing template content validation');
            
            // Check for placeholder indicators in target that suggest it's a template
            const commonPlaceholders = ["detailed copy", "title of the content", "summary of the content", "lorem ipsum"];
            
            // If target contains placeholders, do a more thorough check of response quality
            const targetHasPlaceholders = commonPlaceholders.some(p => 
              (targetItem.text && targetItem.text.includes(p)) || 
              (targetItem.title && targetItem.title.includes(p)) ||
              (targetItem.description && targetItem.description.includes(p))
            );
            
            if (targetHasPlaceholders) {
              console.log('[TargetProcessorAgent] Target contains placeholder indicators, validating content quality');
              
              // For blog posts specifically, validate the content more thoroughly
              if (!this.validateContentQuality(targetItem, resultItem)) {
                console.warn('[TargetProcessorAgent] Blog post content failed quality validation');
                return false;
              }
              
              // Additional check - if template has very short text but result has very long text,
              // this is usually fine (and expected!)
              if (targetItem.text && resultItem.text && 
                  targetItem.text.length < 30 && resultItem.text.length > 500) {
                console.log('[TargetProcessorAgent] Template text is short but result is long - this is good!');
                // This is actually good! Continue validation
              }
            }
          }
          
          // Special check for placeholder content in templates
          // If target has placeholder text like "detailed copy" or "title of the content",
          // then result should NOT contain the same placeholder text
          const placeholderTexts = ["detailed copy", "title of the content", "summary of the content"];
          for (const placeholder of placeholderTexts) {
            if (targetItem.text && targetItem.text.includes(placeholder) && 
                resultItem.text && resultItem.text.includes(placeholder)) {
              console.warn(`[TargetProcessorAgent] El resultado contiene texto placeholder "${placeholder}" del template`);
              return false;
            }
          }
          
          // Verificar campos críticos para objetos tipo blog post
          const criticalFields = ['text', 'type', 'title'];
          for (const field of criticalFields) {
            if (targetItem[field] && !resultItem[field]) {
              console.warn(`[TargetProcessorAgent] Falta el campo crítico "${field}" en el resultado`);
              return false;
            }
          }
        }
        // Verificación normal para arrays simples
        else if (targetContent.length > 0) {
          for (let j = 0; j < Math.min(targetContent.length, resultContent.length); j++) {
            const targetItem = targetContent[j];
            const resultItem = resultContent[j];
            
            // Verificar que las propiedades coincidan para tipos simples
            if (typeof targetItem !== 'object' && typeof resultItem !== 'object') {
              if (typeof targetItem !== typeof resultItem) {
                console.warn(`[TargetProcessorAgent] Los tipos del elemento ${j} no coinciden: target=${typeof targetItem}, result=${typeof resultItem}`);
                return false;
              }
            }
            // Para objetos, usar comparación de propiedades
            else if (typeof targetItem === 'object' && targetItem !== null && 
                typeof resultItem === 'object' && resultItem !== null) {
              if (!this.compareProperties(targetItem, resultItem)) {
                console.warn(`[TargetProcessorAgent] Las propiedades del elemento ${j} no coinciden`);
                return false;
              }
            }
          }
        }
      } 
      // Si son objetos, verificar que las propiedades coincidan
      else if (typeof targetContent === 'object' && typeof resultContent === 'object') {
        if (!this.compareProperties(targetContent, resultContent)) {
          console.warn(`[TargetProcessorAgent] Las propiedades del contenido no coinciden`);
          return false;
        }
      }
      // Si son de tipos diferentes, fallar
      else if (typeof targetContent !== typeof resultContent) {
        console.warn(`[TargetProcessorAgent] Los tipos de contenido no coinciden: target=${typeof targetContent}, result=${typeof resultContent}`);
        return false;
      }
    }

    console.log('[TargetProcessorAgent] All structure and content validations passed successfully');
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
      if (Array.isArray(obj[obj.type])) return obj.type;
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
    
    // Para objetos blog post o similares, solo verificar campos críticos
    // en lugar de todas las propiedades exactamente
    if (target.text && target.type && target.title) {
      const criticalFields = ['text', 'type', 'title'];
      for (const field of criticalFields) {
        if (target[field] && !result[field]) {
          console.warn(`[TargetProcessorAgent] Falta el campo crítico "${field}" en el resultado`);
          return false;
        }
        
        // Verificar tipos de campos críticos
        if (target[field] && result[field] && typeof target[field] !== typeof result[field]) {
          console.warn(`[TargetProcessorAgent] El tipo del campo "${field}" no coincide: target=${typeof target[field]}, result=${typeof result[field]}`);
          return false;
        }
      }
      
      // Si los campos críticos existen y son del tipo correcto, aceptar el objeto
      return true;
    }
    
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
    
    // Verificar los valores de las propiedades
    for (const key of targetKeys) {
      const targetValue = target[key];
      const resultValue = result[key];
      
      // Si son objetos, comparar recursivamente
      if (typeof targetValue === 'object' && targetValue !== null && 
          typeof resultValue === 'object' && resultValue !== null) {
        if (!this.compareProperties(targetValue, resultValue)) {
          return false;
        }
      }
      // Si son arrays, verificar que tengan la misma longitud y elementos
      else if (Array.isArray(targetValue) && Array.isArray(resultValue)) {
        if (targetValue.length !== resultValue.length) {
          console.warn(`[TargetProcessorAgent] La longitud del array "${key}" no coincide: target=${targetValue.length}, result=${resultValue.length}`);
          return false;
        }
        
        // Verificar cada elemento del array
        for (let i = 0; i < targetValue.length; i++) {
          const targetItem = targetValue[i];
          const resultItem = resultValue[i];
          
          // Si son objetos, comparar recursivamente
          if (typeof targetItem === 'object' && targetItem !== null && 
              typeof resultItem === 'object' && resultItem !== null) {
            if (!this.compareProperties(targetItem, resultItem)) {
              return false;
            }
          }
          // Si son de tipos diferentes, fallar
          else if (typeof targetItem !== typeof resultItem) {
            console.warn(`[TargetProcessorAgent] Los tipos de los elementos del array "${key}" no coinciden: target=${typeof targetItem}, result=${typeof resultItem}`);
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