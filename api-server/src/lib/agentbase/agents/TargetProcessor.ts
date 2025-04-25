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
// Importamos la función de validación como JavaScript
import { validateResults } from './targetEvaluator/validateResults.js';

// Definir el tipo de retorno de validateResults para TypeScript
interface ValidationResult {
  isValid: boolean;
  error?: string;
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
      modelId: 'gpt-4.1',
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
          results: [{
            type: 'text',
            content: 'No targets specified for processing'
          }]
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
        command.targets, 
        command.tools || []
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
      
      // Configure model options
      const modelOptions: PortkeyModelOptions = {
        modelType: command.model_type || this.defaultOptions.modelType,
        modelId: command.model_id || this.defaultOptions.modelId,
        maxTokens: command.max_tokens || this.defaultOptions.maxTokens,
        temperature: command.temperature || this.defaultOptions.temperature
      };
      
      console.log(`[TargetProcessor] Using model: ${modelOptions.modelId}`);
      console.log(`[TargetProcessor] Calling LLM with ${messages.length} messages`);
      
      // Call LLM to process target
      const llmResponse = await this.connector.callAgent(messages, modelOptions);
      
      // Extract token usage
      const tokenUsage = extractTokenUsage(llmResponse);
      
      // Extract content from response
      const responseContent = typeof llmResponse === 'object' && llmResponse.content 
        ? llmResponse.content 
        : llmResponse;
        
      console.log(`[TargetProcessor] Response received: ${typeof responseContent === 'string' ? responseContent.substring(0, 100) + '...' : 'non-string'}`);
      
      // Procesar el contenido del LLM para obtener el results
      let results;
      
      // Convertir la respuesta a un arreglo de objetos si es necesario
      try {
        if (typeof responseContent === 'string') {
          // Intenta parsear el string como JSON si tiene formato de arreglo JSON
          if (responseContent.trim().startsWith('[') && responseContent.trim().endsWith(']')) {
            try {
              results = JSON.parse(responseContent);
              console.log(`[TargetProcessor] Respuesta parseada como arreglo JSON: ${results.length} elementos`);
            } catch (e) {
              // Si falla el parsing, usar como texto simple
              results = [{
                type: command.targets[0].type || 'text',
                content: responseContent
              }];
              console.log(`[TargetProcessor] Respuesta procesada como texto simple`);
            }
          } else {
            // Si no tiene formato de arreglo JSON, usar como texto simple
            results = [{
              type: command.targets[0].type || 'text',
              content: responseContent
            }];
            console.log(`[TargetProcessor] Respuesta procesada como texto simple`);
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
          // Caso por defecto
          results = [{
            type: command.targets[0].type || 'text',
            content: String(responseContent)
          }];
          console.log(`[TargetProcessor] Respuesta convertida a texto: ${String(responseContent).substring(0, 30)}...`);
        }
        
        // Log para verificar estructura de resultados
        console.log(`[TargetProcessor] ESTRUCTURA DE RESULTADOS: ${results.map((r: any, i: number) => {
          return `Resultado ${i}: ${Object.keys(r).join(',')}`;
        }).join(' | ')}`);
        
      } catch (error) {
        console.error(`[TargetProcessor] Error procesando respuesta:`, error);
        results = [{
          type: 'text',
          content: typeof responseContent === 'string' ? responseContent : JSON.stringify(responseContent)
        }];
      }
      
      // Validar los resultados usando el servicio validateResults
      const validation = validateResults(results, command.targets) as ValidationResult;
      
      if (!validation.isValid) {
        console.warn(`[TargetProcessor] Validación de resultados falló: ${validation.error}`);
        throw new Error(`Validación de resultados falló: ${validation.error}`);
      }
      
      // Log detailed results summary
      console.log(`[TargetProcessor] Results procesados y validados: ${results.length} elementos`);
      
      // Crear una copia independiente de los resultados para el comando
      const resultsCopy = JSON.parse(JSON.stringify(results));
      
      // Log de estructura de resultados copiados
      console.log(`[TargetProcessor] ESTRUCTURA DE RESULTADOS COPIADOS: ${resultsCopy.map((r: any, i: number) => {
        return `Resultado ${i}: ${Object.keys(r).join(',')}`;
      }).join(' | ')}`);
      
      // Asegurar que el agent_background se mantenga en el comando actualizado si existe
      const updatedCommand = {
        ...command,
        results: resultsCopy
      };
      
      console.log(`[TargetProcessor] Asignando resultados para comando ${command.id}: ${resultsCopy.length} resultados`);
      console.log(`[TargetProcessor] Comando ahora tiene ${updatedCommand.results?.length || 0} resultados total`);
      
      // Verificar si el comando actualizado tiene resultados
      if (!updatedCommand.results || updatedCommand.results.length === 0) {
        console.error(`[TargetProcessor] ⚠️ ALERTA: EL COMANDO ACTUALIZADO NO TIENE RESULTADOS. Original tenía ${command.results?.length || 0} y se añadieron ${resultsCopy.length}`);
      } else {
        console.log(`[TargetProcessor] ✅ El comando tiene ${updatedCommand.results.length} resultados después de la actualización`);
      }
      
      // Guardar en caché para futuras consultas
      // Guardar los resultados en la caché siempre, independientemente de agent_background
      CommandCache.cacheCommand(command.id, {
        ...command,
        results: resultsCopy
      });
      
      console.log(`[TargetProcessor] Resultados actualizados en caché: ${resultsCopy.length} resultados totales`);
      
      // Verificar que se guardaron en caché
      const cachedCmd = CommandCache.getCachedCommand(command.id);
      if (cachedCmd && cachedCmd.results) {
        console.log(`[TargetProcessor] ✅ Verificación: Caché tiene ${cachedCmd.results.length} resultados`);
      } else {
        console.error(`[TargetProcessor] ⚠️ ALERTA: NO SE GUARDARON RESULTADOS EN CACHÉ`);
      }
      
      
      // Verificación final de estructura de resultados en la respuesta
      console.log(`[TargetProcessor] VERIFICACIÓN FINAL - RESULTADOS EN RESPUESTA: ${resultsCopy.length} elementos`);
      console.log(`[TargetProcessor] VERIFICACIÓN FINAL - UPDATEDCOMMAND: ${updatedCommand.results?.length || 0} elementos`);
      
      // Asegurar que los resultados no estén vacíos antes de retornarlos
      if (resultsCopy.length === 0) {
        console.error(`[TargetProcessor] ALERTA CRÍTICA: No hay resultados a retornar. Creando un resultado mínimo.`);
        const defaultResult = {
          type: command.targets[0]?.type || 'text',
          content: typeof responseContent === 'string' ? responseContent : 'Procesamiento completado sin resultados específicos'
        };
        resultsCopy.push(defaultResult);
        
        // Actualizar también el comando con este resultado mínimo
        if (!updatedCommand.results) {
          updatedCommand.results = [defaultResult];
        } else {
          updatedCommand.results.push(defaultResult);
        }
        console.log(`[TargetProcessor] Resultado mínimo creado: ${JSON.stringify(defaultResult).substring(0, 100)}...`);
      }
      
      // Return result
      return {
        status: 'completed',
        results: resultsCopy,
        updatedCommand: updatedCommand,
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens
      };
    } catch (error: any) {
      console.error(`[TargetProcessor] Error processing target: ${error.message}`);
      return {
        status: 'failed',
        error: `Target processing failed: ${error.message}`
      };
    }
  }
} 