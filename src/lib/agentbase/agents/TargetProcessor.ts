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
import { parseTargetResponseContent } from './targetEvaluator/parseTargetResponse';
import {
  applyTargetSchemaValidation,
  MAX_PARSE_RETRIES,
  schemaRetryUserMessage,
} from './targetEvaluator/schemaRetry';

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
      modelId: 'gpt-5.6-sol',
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
      const isGpt55Family = parsedModelType === 'openai' && (parsedModelId === 'gpt-5.6-sol' || parsedModelId === 'gpt-5-mini');
      const defaultMax = isGpt55Family ? 32768 : (this.defaultOptions.maxTokens || 16384);
      const modelOptions: PortkeyModelOptions = {
        modelType: parsedModelType,
        modelId: parsedModelId,
        maxTokens: command.max_tokens || defaultMax,
        temperature: command.temperature || this.defaultOptions.temperature,
        stream: this.defaultOptions.stream || false,
        streamOptions: {
          includeUsage: true
        },
        siteId: command.site_id,
      };

      console.log(`[TargetProcessor] Using model: ${modelOptions.modelId}`);
      console.log(`[TargetProcessor] Calling LLM with ${messages.length} messages - STREAMING ${modelOptions.stream ? 'ENABLED' : 'DISABLED'}`);

      const workingMessages = [...messages];
      let parseAttempt = 0;
      let results: any[] | null = null;
      let tokenUsage = { inputTokens: 0, outputTokens: 0 };
      let lastError: Error | null = null;

      while (parseAttempt < MAX_PARSE_RETRIES && !results) {
        parseAttempt++;

        if (parseAttempt > 1 && lastError) {
          console.log(`[TargetProcessor] Schema retry ${parseAttempt}/${MAX_PARSE_RETRIES}: ${lastError.message}`);
          workingMessages.push({
            role: 'user',
            content: schemaRetryUserMessage(lastError.message),
          });
        }

        let llmResponse;
        try {
          llmResponse = await this.connector.callAgent(workingMessages, modelOptions);
        } catch (error: any) {
          if (error.message?.includes('Rate limit exceeded') ||
            error.message?.includes('exceeded token rate limit') ||
            error.message?.includes('AIServices S0 pricing tier')) {
            console.error(`[TargetProcessor] Rate limit error from connector: ${error.message}`);
            return {
              status: 'failed',
              error: `Rate limit exceeded: ${error.message}. Please try again later.`
            };
          }
          throw error;
        }

        if (llmResponse && typeof llmResponse === 'object' && (llmResponse.error || (typeof llmResponse.content === 'string' && llmResponse.content.startsWith('Error calling LLM:')))) {
          const errMsg = llmResponse.error || llmResponse.content;
          console.error(`[TargetProcessor] Connector returned error-shaped response: ${errMsg}`);
          return {
            status: 'failed',
            error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)
          };
        }

        if (llmResponse.isStream) {
          console.log(`[TargetProcessor] Processing streaming response...`);
          return await StreamingResponseProcessor.processStreamingResponse(
            llmResponse.stream,
            command,
            llmResponse.modelInfo,
            this.fillTargetWithContent.bind(this)
          );
        }

        const currentTokenUsage = extractTokenUsage(llmResponse);
        tokenUsage.inputTokens += currentTokenUsage.inputTokens;
        tokenUsage.outputTokens += currentTokenUsage.outputTokens;

        const responseContent = typeof llmResponse === 'object' && llmResponse.content
          ? llmResponse.content
          : llmResponse;

        const parsed = parseTargetResponseContent(responseContent, command.targets);
        if (!parsed.ok) {
          lastError = new Error(parsed.error);
          console.error(`[TargetProcessor] Parse failed (attempt ${parseAttempt}/${MAX_PARSE_RETRIES}):`, parsed.error);
          continue;
        }

        console.log(`[TargetProcessor] ESTRUCTURA DE RESULTADOS: ${parsed.results.map((r: any, i: number) => {
          return `Resultado ${i}: ${Object.keys(r || {}).join(',')}`;
        }).join(' | ')}`);

        const validation = applyTargetSchemaValidation(parsed.results, command.targets);
        if (validation.correctedResults) {
          console.log(`[TargetProcessor] Using correctedResults from validation (${validation.correctedResults.length} items)`);
          results = validation.correctedResults;
          break;
        }
        if (!validation.isValid) {
          lastError = new Error(validation.error || 'Target schema validation failed');
          console.warn(`[TargetProcessor] Schema validation failed (attempt ${parseAttempt}/${MAX_PARSE_RETRIES}): ${lastError.message}`);
          continue;
        }

        results = validation.results || parsed.results;
      }

      if (!results) {
        return {
          status: 'failed',
          results: null as any,
          error: `Could not extract valid JSON from LLM response after ${MAX_PARSE_RETRIES} retries. Last error: ${lastError?.message || 'Unknown error'}`
        };
      }

      // Log detailed results summary
      console.log(`[TargetProcessor] Results procesados y validados: ${(results as any)?.length || 0} elementos`);

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
} 