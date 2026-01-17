/**
 * TargetProcessor - Procesador especializado para generar respuestas
 * basadas en el contexto del usuario y los resultados de herramientas.
 */
import { Base } from './Base';
import { PortkeyConnector } from '../services/PortkeyConnector';
import { DbCommand, CommandExecutionResult, PortkeyModelOptions } from '../models/types';
import { TARGET_PROCESSOR_SYSTEM_PROMPT, formatTargetProcessorPrompt } from '../prompts/target-processor-prompt';
import { prepareMessagesForTarget } from './targetEvaluator/formatters/target-message-formatter';
import { extractTokenUsage } from './toolEvaluator/tokenUtils';
import { CommandCache } from '../services/command/CommandCache';
import { DatabaseAdapter } from '../adapters/DatabaseAdapter';
import { StreamingResponseProcessor } from './streaming/StreamingResponseProcessor';
// Importamos la función de validación como JavaScript
import { validateResults } from './targetEvaluator/validateResults.js';

// Definir el tipo de retorno de validateResults para TypeScript
interface ValidationResult {
  isValid: boolean;
  error?: string;
  correctedResults?: any[]; // Resultados corregidos si se detectó una estructura malformada
}

export class TargetProcessor extends Base {
  private connector: PortkeyConnector;
  private defaultOptions: PortkeyModelOptions;
  readonly systemPrompt?: string;
  readonly agentSystemPrompt?: string;

  constructor(
    id: string,
    name: string,
    connector: PortkeyConnector,
    capabilities: string[] = ['target_processing'],
    defaultOptions?: PortkeyModelOptions,
    systemPrompt?: string,
    agentSystemPrompt?: string
  ) {
    super(id, name, capabilities);
    this.connector = connector;
    this.defaultOptions = defaultOptions || {
      modelType: 'openai',
      modelId: 'gpt-5.2',
      maxTokens: 32768,
      temperature: 0.7,
      responseFormat: 'text'
    };
    this.systemPrompt = systemPrompt;
    this.agentSystemPrompt = agentSystemPrompt;

    if (this.systemPrompt) {
      console.log(`[TargetProcessor] System prompt provided: ${this.systemPrompt.substring(0, 100)}...`);
    }

    if (this.agentSystemPrompt) {
      console.log(`[TargetProcessor] Agent system prompt provided: ${this.agentSystemPrompt.substring(0, 100)}...`);
    }
  }

  async executeCommand(command: DbCommand): Promise<CommandExecutionResult> {
    try {
      // Verificar si existe agent_background
      if (!command.agent_background) {
        console.log(`[TargetProcessor] Comando sin agent_background, intentando recuperar...`);

        // Intentar recuperar desde la caché
        const cachedCommand = CommandCache.getCachedCommand(command.id);
        if (cachedCommand?.agent_background) {
          console.log(`[TargetProcessor] agent_background recuperado desde caché`);
          command.agent_background = cachedCommand.agent_background;
        }
        // Si no está en caché y tenemos agent_id, intentar obtenerlo de la BD
        else if (command.agent_id) {
          try {
            // Verificar directamente en BD a través de DatabaseAdapter
            const verification = await DatabaseAdapter.verifyAgentBackground(command.id);

            if (verification.hasBackground && verification.value) {
              command.agent_background = verification.value;
              console.log(`[TargetProcessor] agent_background recuperado desde BD`);
            } else {
              // Si no se pudo recuperar, lanzar error
              throw new Error(`No se encontró agent_background para el comando ${command.id}`);
            }
          } catch (error: any) {
            throw new Error(`Error recuperando agent_background: ${error.message}`);
          }
        } else {
          throw new Error(`Comando sin agent_id ni agent_background. Imposible continuar.`);
        }
      }

      console.log(`[TargetProcessor] Processing command: ${command.id}`);

      if (!command.targets || command.targets.length === 0) {
        console.log(`[TargetProcessor] No targets to process`);
        return {
          status: 'completed',
          results: [],
          error: 'No targets specified for processing'
        };
      }

      // Log targets para diagnóstico
      console.log(`[TargetProcessor] Targets definidos (${command.targets.length}):`, JSON.stringify(command.targets.map(t => {
        const keys = Object.keys(t);
        return `{${keys.join(',')}}`;
      })));

      // Generate formatted prompt using formatTargetProcessorPrompt
      const userMessage = command.context || 'No user message provided';
      const formattedUserMessage = typeof userMessage === 'string' ? userMessage : JSON.stringify(userMessage);

      // Generate the target-specific formatted prompt
      const formattedTargetPrompt = formatTargetProcessorPrompt(
        formattedUserMessage,
        command.targets
      );

      console.log(`[TargetProcessor] Generated formatted target prompt: ${formattedTargetPrompt.substring(0, 100)}...`);

      // Use the general system prompt from our class or the default
      const targetSystemPrompt = this.systemPrompt || TARGET_PROCESSOR_SYSTEM_PROMPT;
      const agentPrompt = this.agentSystemPrompt || "";

      // Prepare merged system prompts but replace the user message with our formatted target prompt
      const messages = prepareMessagesForTarget(
        {
          ...command,
          // Override the context with our formatted target prompt
          context: formattedTargetPrompt
        },
        targetSystemPrompt,
        agentPrompt
      );

      // Parse model field if it contains modelType:modelId format
      let parsedModelType = command.model_type || this.defaultOptions.modelType;
      let parsedModelId = command.model_id || this.defaultOptions.modelId;

      if (command.model && command.model.includes(':')) {
        const [modelType, modelId] = command.model.split(':');
        // Validate modelType
        if (['anthropic', 'openai', 'gemini'].includes(modelType)) {
          parsedModelType = modelType as 'anthropic' | 'openai' | 'gemini';
          parsedModelId = modelId;
          console.log(`[TargetProcessor] Parsed model field: ${modelType}:${modelId}`);
        } else {
          console.warn(`[TargetProcessor] Invalid modelType: ${modelType}, using default`);
          parsedModelId = command.model; // Use the whole string as modelId
        }
      } else if (command.model) {
        parsedModelId = command.model;
      }

      // Configure model options - default to non-streaming for stability
      const isGpt52Family = parsedModelType === 'openai' && (parsedModelId === 'gpt-5.2' || parsedModelId === 'gpt-5-mini' || parsedModelId === 'gpt-5-nano');
      const defaultMax = isGpt52Family ? 32768 : (this.defaultOptions.maxTokens || 16384);
      const modelOptions: PortkeyModelOptions = {
        modelType: parsedModelType,
        modelId: parsedModelId,
        maxTokens: command.max_tokens || defaultMax,
        temperature: command.temperature || this.defaultOptions.temperature,
        stream: this.defaultOptions.stream || false,
        streamOptions: {
          includeUsage: true
        }
      };

      console.log(`[TargetProcessor] Using model: ${modelOptions.modelId}`);
      console.log(`[TargetProcessor] Calling LLM with ${messages.length} messages - STREAMING ${modelOptions.stream ? 'ENABLED' : 'DISABLED'}`);

      // Retry loop for malformed LLM responses
      const MAX_PARSE_RETRIES = 2;
      let parseAttempt = 0;
      let results: any[] | null = null;
      let tokenUsage = { inputTokens: 0, outputTokens: 0 };
      let lastError: Error | null = null;

      while (parseAttempt < MAX_PARSE_RETRIES && !results) {
        parseAttempt++;
        
        if (parseAttempt > 1) {
          console.log(`[TargetProcessor] Reintento ${parseAttempt}/${MAX_PARSE_RETRIES} por respuesta malformada del LLM`);
        }

        // Call LLM to process target
        let llmResponse;
        try {
          llmResponse = await this.connector.callAgent(messages, modelOptions);
        } catch (error: any) {
          // Check if it's a rate limit error
          if (error.message?.includes('Rate limit exceeded') ||
            error.message?.includes('exceeded token rate limit') ||
            error.message?.includes('AIServices S0 pricing tier')) {
            console.error(`[TargetProcessor] Rate limit error from connector: ${error.message}`);
            return {
              status: 'failed',
              error: `Rate limit exceeded: ${error.message}. Please try again later.`
            };
          }
          throw error; // Re-throw other errors
        }

        // Guard against error-shaped responses mistakenly returned as success
        if (llmResponse && typeof llmResponse === 'object' && (llmResponse.error || (typeof llmResponse.content === 'string' && llmResponse.content.startsWith('Error calling LLM:')))) {
          const errMsg = llmResponse.error || llmResponse.content;
          console.error(`[TargetProcessor] Connector returned error-shaped response: ${errMsg}`);
          return {
            status: 'failed',
            error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)
          };
        }

        // Handle streaming response
        if (llmResponse.isStream) {
          console.log(`[TargetProcessor] Processing streaming response...`);
          return await StreamingResponseProcessor.processStreamingResponse(
            llmResponse.stream,
            command,
            llmResponse.modelInfo,
            this.fillTargetWithContent.bind(this)
          );
        }

        // Extract token usage and accumulate across retries
        const currentTokenUsage = extractTokenUsage(llmResponse);
        tokenUsage.inputTokens += currentTokenUsage.inputTokens;
        tokenUsage.outputTokens += currentTokenUsage.outputTokens;

        // Extract content from response
        const responseContent = typeof llmResponse === 'object' && llmResponse.content
          ? llmResponse.content
          : llmResponse;

        console.log(`[TargetProcessor] Response received: ${typeof responseContent === 'string' ? responseContent.substring(0, 100) + '...' : 'non-string'}`);

        // Procesar el contenido del LLM para obtener el results
        try {
          if (typeof responseContent === 'string') {
            // Intenta parsear el string como JSON si tiene formato de arreglo JSON
            if (responseContent.trim().startsWith('[') && responseContent.trim().endsWith(']')) {
              try {
                results = JSON.parse(responseContent);
                console.log(`[TargetProcessor] Respuesta parseada como arreglo JSON: ${results.length} elementos`);
              } catch (e) {
                // Si falla el parsing de array, intentar extraer JSON embebido que coincida con targets
                console.log(`[TargetProcessor] Error parsing array JSON, intentando extraer JSON embebido`);
                const extractedJson = this.extractEmbeddedJsonMatchingTargets(responseContent, command.targets);
                
                if (extractedJson) {
                  results = extractedJson;
                  console.log(`[TargetProcessor] Usando JSON extraido del texto: ${results.length} elementos`);
                } else {
                  // Si no se puede extraer JSON valido, lanzar error para trigger retry
                  console.error(`[TargetProcessor] No se pudo extraer JSON valido que coincida con targets`);
                  throw new Error(`Invalid LLM response: Could not extract JSON matching target structure. Response started with: "${responseContent.substring(0, 100)}..."`);
                }
              }
            } else {
              // Intentar parsear como JSON simple (objeto o array) antes de usar como texto
              try {
                const parsedContent = JSON.parse(responseContent);
                // Si se parsea correctamente, usar la estructura original
                if (Array.isArray(parsedContent)) {
                  results = parsedContent;
                  console.log(`[TargetProcessor] Respuesta parseada como arreglo JSON válido: ${results.length} elementos`);
                } else if (typeof parsedContent === 'object' && parsedContent !== null) {
                  results = [parsedContent];
                  console.log(`[TargetProcessor] Respuesta parseada como objeto JSON válido y envuelta en array`);
                } else {
                  // Si es un valor primitivo parseado, lanzar error - no es estructura valida
                  throw new Error(`Invalid LLM response: Expected JSON array or object, got primitive value`);
                }
              } catch (parseError) {
                // Intentar extraer JSON embebido que coincida con la estructura de targets
                const extractedJson = this.extractEmbeddedJsonMatchingTargets(responseContent, command.targets);
                
                if (extractedJson) {
                  results = extractedJson;
                  console.log(`[TargetProcessor] Usando JSON extraido del texto: ${results.length} elementos`);
                } else {
                  // Si no se puede extraer JSON valido, lanzar error para trigger retry
                  console.error(`[TargetProcessor] No se pudo extraer JSON valido que coincida con targets`);
                  throw new Error(`Invalid LLM response: Could not extract JSON matching target structure. Response started with: "${responseContent.substring(0, 100)}..."`);
                }
              }
            }
          } else if (Array.isArray(responseContent)) {
            // Si ya es un arreglo, usarlo directamente
            results = responseContent;
            console.log(`[TargetProcessor] Respuesta ya es un arreglo: ${results.length} elementos`);
          } else if (typeof responseContent === 'object') {
            // Si es un objeto pero no un arreglo, envolverlo en un arreglo
            results = [responseContent];
            console.log(`[TargetProcessor] Respuesta envuelta en arreglo: objeto simple`);
          } else {
            // Tipo de respuesta no esperado, lanzar error para retry
            throw new Error(`Invalid LLM response: Expected JSON array or object, got ${typeof responseContent}`);
          }

          // Log para verificar estructura de resultados
          if (results) {
            console.log(`[TargetProcessor] ESTRUCTURA DE RESULTADOS: ${results.map((r: any, i: number) => {
              return `Resultado ${i}: ${Object.keys(r).join(',')}`;
            }).join(' | ')}`);
          }

        } catch (error: any) {
          console.error(`[TargetProcessor] Error procesando respuesta (intento ${parseAttempt}/${MAX_PARSE_RETRIES}):`, error.message);
          lastError = error;
          results = null; // Reset results to trigger retry
          
          // Si es el ultimo intento, no continuamos el loop
          if (parseAttempt >= MAX_PARSE_RETRIES) {
            console.error(`[TargetProcessor] Todos los reintentos agotados, fallando comando`);
          }
        }
      }

      // Si no se pudieron obtener resultados despues de todos los reintentos, fallar
      if (!results) {
        return {
          status: 'failed',
          error: `Could not extract valid JSON from LLM response after ${MAX_PARSE_RETRIES} retries. Last error: ${lastError?.message || 'Unknown error'}`
        };
      }

      // Validar los resultados usando el servicio validateResults
      const validation = validateResults(results, command.targets) as ValidationResult;

      if (!validation.isValid) {
        console.warn(`[TargetProcessor] Validación de resultados falló: ${validation.error}`);
        throw new Error(`Validación de resultados falló: ${validation.error}`);
      }

      // 🔧 Si la validación devolvió resultados corregidos (estructura malformada detectada y corregida),
      // usar esos resultados en lugar de los originales
      if (validation.correctedResults) {
        console.log(`[TargetProcessor] ✅ Usando resultados corregidos de la validación (${validation.correctedResults.length} elementos)`);
        results = validation.correctedResults;
      }

      // Log detailed results summary
      console.log(`[TargetProcessor] Results procesados y validados: ${results.length} elementos`);

      // Crear una copia independiente de los resultados para el comando
      const resultsCopy = JSON.parse(JSON.stringify(results));



      // Asegurar que el agent_background se mantenga en el comando actualizado si existe
      // Crear una copia limpia del comando para evitar referencias circulares
      const updatedCommand = {
        ...command,
        results: resultsCopy,
        updated_at: new Date().toISOString()
      };



      // Verificar si el comando actualizado tiene resultados
      if (!updatedCommand.results || updatedCommand.results.length === 0) {
        console.error(`[TargetProcessor] ⚠️ ALERTA: EL COMANDO ACTUALIZADO NO TIENE RESULTADOS`);
      }

      // Guardar en caché para futuras consultas
      // Guardar los resultados en la caché siempre, independientemente de agent_background
      CommandCache.cacheCommand(command.id, {
        ...command,
        results: resultsCopy
      });






      // Asegurar que los resultados no estén vacíos antes de retornarlos
      if (resultsCopy.length === 0) {
        console.error(`[TargetProcessor] ALERTA CRÍTICA: No hay resultados a retornar. Creando resultados basados en estructura de targets.`);

        // Crear resultados usando la estructura de targets con contenido por defecto
        const defaultResults = command.targets.map((target, index) => {
          const targetCopy = JSON.parse(JSON.stringify(target));
          const defaultContent = 'Procesamiento completado sin resultados específicos';
          return this.fillTargetWithContent(targetCopy, defaultContent);
        });

        resultsCopy.push(...defaultResults);

        // Actualizar también el comando con estos resultados mínimos
        if (!updatedCommand.results) {
          updatedCommand.results = [...defaultResults];
        } else {
          updatedCommand.results.push(...defaultResults);
        }
        console.log(`[TargetProcessor] ${defaultResults.length} resultados mínimos creados preservando estructura de targets`);
      }



      // Crear el resultado final
      const finalResult = {
        status: 'completed' as const,
        results: resultsCopy,
        updatedCommand: updatedCommand,
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens
      };



      // Return result
      return finalResult;
    } catch (error: any) {
      console.error(`[TargetProcessor] Error processing target: ${error.message}`);
      return {
        status: 'failed',
        error: `Target processing failed: ${error.message}`
      };
    }
  }

  /**
   * Rellena un target con contenido preservando su estructura original
   * @param target El target original a llenar
   * @param content El contenido a insertar
   * @returns El target con contenido aplicado
   */
  private fillTargetWithContent(target: any, content: any): any {
    if (!target || typeof target !== 'object') {
      return target;
    }

    const result = { ...target };
    const targetKeys = Object.keys(result);

    // 🔧 FIX: Si el target tiene una sola key con un objeto anidado (e.g., { follow_up_content: {...} }),
    // y el contenido es un objeto que tiene esa misma key, preservar la estructura anidada
    if (targetKeys.length === 1) {
      const targetKey = targetKeys[0];
      const targetValue = result[targetKey];
      
      // Si el valor del target es un objeto (no array, no string vacío)
      if (typeof targetValue === 'object' && targetValue !== null && !Array.isArray(targetValue)) {
        // Si el contenido es un objeto y tiene la misma key, usar ese contenido directamente
        if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
          if (content[targetKey]) {
            // El contenido tiene la misma estructura, preservarla
            return { [targetKey]: content[targetKey] };
          } else if (Object.keys(content).length > 0) {
            // El contenido es un objeto pero sin la key, rellenar el objeto anidado con el contenido
            return { [targetKey]: this.fillTargetWithContent(targetValue, content) };
          }
        }
        // Si el contenido es un string o array, rellenar recursivamente el objeto anidado
        return { [targetKey]: this.fillTargetWithContent(targetValue, content) };
      }
    }

    // Buscar propiedades que puedan contener el contenido
    const possibleContentFields = ['content', 'contents', 'text', 'message', 'description', 'value'];

    for (const field of possibleContentFields) {
      if (field in result) {
        // Si encontramos un campo de contenido, llenarlo con el contenido proporcionado
        if (typeof result[field] === 'string') {
          result[field] = typeof content === 'string' ? content : JSON.stringify(content);
        } else if (Array.isArray(result[field])) {
          // Si es un array, mantener la estructura pero con nuevo contenido
          result[field] = Array.isArray(content) ? content : [content];
        } else if (typeof result[field] === 'object' && result[field] !== null) {
          // Si es un objeto, intentar rellenarlo recursivamente
          result[field] = this.fillTargetWithContent(result[field], content);
        }
        break;
      }
    }

    // Si no encontramos campos de contenido obvios, buscar el primer campo string o objeto
    if (!possibleContentFields.some(field => field in result)) {
      const keys = Object.keys(result);
      for (const key of keys) {
        if (typeof result[key] === 'string' && result[key].trim() === '') {
          result[key] = typeof content === 'string' ? content : JSON.stringify(content);
          break;
        } else if (typeof result[key] === 'object' && result[key] !== null) {
          result[key] = this.fillTargetWithContent(result[key], content);
          break;
        }
      }
    }

    return result;
  }

  /**
   * Finds all balanced JSON arrays in a text string
   * Uses bracket counting to find properly balanced arrays
   * @param text The text to search for JSON arrays
   * @returns Array of JSON array strings, sorted by length (longest first)
   */
  private findAllJsonArrays(text: string): string[] {
    const candidates: string[] = [];
    let depth = 0;
    let start = -1;
    
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '[') {
        if (depth === 0) start = i;
        depth++;
      } else if (text[i] === ']') {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(text.substring(start, i + 1));
          start = -1;
        }
      }
    }
    
    // Sort by length descending - longer arrays are more likely to be complete
    return candidates.sort((a, b) => b.length - a.length);
  }

  /**
   * Extracts embedded JSON from text that matches the expected target structure
   * @param text The text that may contain embedded JSON
   * @param targets The expected targets to validate against
   * @returns The parsed JSON array if found and matching, null otherwise
   */
  private extractEmbeddedJsonMatchingTargets(text: string, targets: any[]): any[] | null {
    if (!text || typeof text !== 'string' || !targets || targets.length === 0) {
      return null;
    }

    // Get expected keys from each target
    const expectedKeys = targets.map(t => Object.keys(t));
    const candidates = this.findAllJsonArrays(text);
    
    console.log(`[TargetProcessor] Buscando JSON embebido en ${candidates.length} candidatos`);
    
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        
        // Must be an array with same number of elements as targets
        if (!Array.isArray(parsed) || parsed.length !== targets.length) {
          continue;
        }
        
        // Validate that each element has at least one matching key with corresponding target
        let allMatch = true;
        for (let i = 0; i < parsed.length; i++) {
          const elementKeys = Object.keys(parsed[i] || {});
          const targetKeys = expectedKeys[i];
          
          // Check if at least one primary key matches
          const hasMatchingKey = targetKeys.some(key => elementKeys.includes(key));
          if (!hasMatchingKey) {
            allMatch = false;
            break;
          }
        }
        
        if (allMatch) {
          console.log(`[TargetProcessor] JSON extraido coincide con estructura de targets (${parsed.length} elementos)`);
          return parsed;
        }
      } catch (e) {
        // Continue to next candidate
        continue;
      }
    }
    
    console.log(`[TargetProcessor] No se encontro JSON embebido que coincida con targets`);
    return null;
  }

} 