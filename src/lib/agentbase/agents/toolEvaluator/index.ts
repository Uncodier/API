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
import { processToolEvaluationResponse, generateFunctions, prepareToolsForExecution } from './responseProcessor';
import { prepareMessagesFromCommand, validateAndNormalizeTools } from './messageFormatter';
import { FunctionCall, ToolExecutionResult } from './types';
import { CommandCache } from '../../services/command/CommandCache';
// Importar directamente CommandService para evitar imports dinámicos
import { CommandService } from '../../services/command';
// Importar desde las nuevas ubicaciones refactorizadas
import { runToolExecution } from './executor/runner';

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
          modelType: command.model_type || this.defaultOptions.modelType || 'openai',
          modelId: command.model_id || this.defaultOptions.modelId || 'gpt-4.1-nano',
          maxTokens: command.max_tokens || this.defaultOptions.maxTokens || 32768,
          temperature: command.temperature || this.defaultOptions.temperature || 0.7,
          responseFormat: command.response_format || this.defaultOptions.responseFormat || 'text'
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
        
        // Loguear la respuesta cruda para diagnóstico
        console.log(`[ToolEvaluator] Raw response content type: ${typeof content}`);
        const contentSample = typeof content === 'string' 
          ? content.substring(0, 200) 
          : JSON.stringify(content).substring(0, 200);
        console.log(`[ToolEvaluator] Content sample: ${contentSample}...`);
        
        // Intentar analizar la respuesta como JSON
        try {
          // Verificar si es un string JSON o un objeto
          let jsonContent = typeof content === 'string' ? content : JSON.stringify(content);
          
          // Si la respuesta contiene un bloque de código, extraerlo
          if (typeof jsonContent === 'string') {
            const codeBlockMatch = jsonContent.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (codeBlockMatch && codeBlockMatch[1]) {
              jsonContent = codeBlockMatch[1].trim();
              console.log(`[ToolEvaluator] Extracted code block from response`);
            }
          }
          
          // Intentar analizar el JSON
          try {
            functions = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
            console.log(`[ToolEvaluator] Successfully parsed JSON response of type: ${typeof functions}`);
            
            // Verificar que functions sea un array
            if (!Array.isArray(functions)) {
              console.log(`[ToolEvaluator] Functions is not an array, converting to array`);
              // Si no es un array, intentar convertirlo o inicializarlo como array vacío
              if (functions && typeof functions === 'object') {
                // Verificar si hay propiedades que sugieran un array embebido
                const functionsObj = functions as Record<string, any>;
                if (functionsObj.items && Array.isArray(functionsObj.items)) {
                  functions = functionsObj.items;
                } else if (functionsObj.functions && Array.isArray(functionsObj.functions)) {
                  functions = functionsObj.functions;
                } else {
                  // Si es un objeto pero no contiene un array, convertirlo a un array con ese objeto
                  functions = [functions];
                }
              } else {
                // Si no es un objeto válido, inicializarlo como array vacío
                functions = [];
              }
            }
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
              
              // Asegurar que functions es un array
              if (!Array.isArray(functions)) {
                console.log(`[ToolEvaluator] Parsed functions is not an array, converting to array`);
                functions = [functions];
              }
            } else {
              throw new Error('El contenido de la respuesta no es un formato JSON válido');
            }
          }
        } catch (parseError) {
          console.error("[ToolEvaluator] Error parsing functions:", parseError);
          throw new Error('Falló el análisis de la respuesta para la evaluación de herramientas');
        }
        
        // Loguear el resultado del parsing
        console.log(`[ToolEvaluator] Parsed ${Array.isArray(functions) ? functions.length : 0} functions from response`);
        
        // Preparar las llamadas a funciones basadas en la respuesta del LLM
        const functionCalls = prepareToolsForExecution(functions, command.tools);
        console.log(`[ToolEvaluator] Generated ${functionCalls.length} function calls from ${Array.isArray(functions) ? functions.length : 0} functions`);
        
        // Extract possible_match function calls
        let possibleMatchCalls: FunctionCall[] = [];
        try {
          // Get all function calls from the response
          const allFunctionCalls = generateFunctions(processToolEvaluationResponse(functions, command.tools));
          
          // Filter only the possible_match status calls
          possibleMatchCalls = allFunctionCalls.filter(call => call.status === 'possible_match');
          
          if (possibleMatchCalls.length > 0) {
            console.log(`[ToolEvaluator] Found ${possibleMatchCalls.length} functions with 'possible_match' status`);
            possibleMatchCalls.forEach(call => {
              console.log(`[ToolEvaluator] Possible match: ${call.name}, missing args: ${call.required_arguments?.join(', ')}`);
            });
          }
        } catch (error) {
          console.error(`[ToolEvaluator] Error extracting possible_match calls: ${error}`);
          possibleMatchCalls = [];
        }
        
        // Verificar que functions sea un array
        if (!Array.isArray(functions) || functions.length === 0) {
          console.warn(`[ToolEvaluator] No valid functions found in response, creating empty array`);
          functions = [];
        }
        
        // Asegurar que todas las funciones tengan un estado válido y un ID único
        const normalizedFunctions: any[] = functions.map((func: any, index: number) => {
          // Generar un ID único para cada función si no tiene uno
          const funcId = func.id || `func_${Date.now()}_${index}`;
          
          // Normalizar argumentos como string JSON
          const args = typeof func.arguments === 'string' 
            ? func.arguments 
            : (func.params ? JSON.stringify(func.params) : '{}');
          
          // Add required_arguments for possible_match status
          const requiredArgs = func.required_arguments || [];
          
          // Estructura completamente plana, sin nodos anidados
          return {
            id: funcId,
            type: "function",
            status: func.status || 'required',
            name: func.name || `function_${index}`,
            arguments: args,
            critical: func.critical || false,
            description: func.description || '',
            required_arguments: requiredArgs
          };
        });
        
        // Usar las funciones normalizadas como las funciones evaluadas
        functions = normalizedFunctions;
        const evaluatedFunctions = functions;
        
        // Ejecutar las herramientas seleccionadas pasando el ID del comando
        if (functionCalls && functionCalls.length > 0) {
          console.log(`[ToolEvaluator] Ejecutando ${functionCalls.length} herramientas seleccionadas`);
          await this.executeSelectedTools(functionCalls, command.tools, command.id, possibleMatchCalls);
        } else if (possibleMatchCalls && possibleMatchCalls.length > 0) {
          console.log(`[ToolEvaluator] No hay herramientas para ejecutar, pero sí ${possibleMatchCalls.length} possible_match`);
          // Pasar un array vacío como functionCalls para solo actualizar el contexto
          await this.executeSelectedTools([], command.tools, command.id, possibleMatchCalls);
        } else {
          console.log(`[ToolEvaluator] No se seleccionaron herramientas para ejecutar`);
        }
        
        // Mantener el comando original pero obtener las funciones actualizadas
        const updatedCommand = { ...command };
        
        // Simplemente usar CommandService para obtener el comando actualizado
        try {
          const commandService = new CommandService();
          const latestCommand = await commandService.getCommandById(command.id);
          
          if (latestCommand && latestCommand.functions && latestCommand.functions.length > 0) {
            console.log(`[ToolEvaluator] Usando funciones actualizadas de la base de datos (${latestCommand.functions.length})`);
            // Usar las funciones actualizadas de la base de datos
            updatedCommand.functions = latestCommand.functions;
          } else {
            console.log(`[ToolEvaluator] No se encontraron funciones actualizadas en la base de datos`);
            // Si no hay funciones actualizadas, usar las funciones evaluadas originales
            updatedCommand.functions = evaluatedFunctions;
            
            // FORZAR GUARDADO de las funciones evaluadas si no se encontraron actualizadas
            if (evaluatedFunctions && evaluatedFunctions.length > 0) {
              console.log(`[ToolEvaluator] FORZANDO GUARDADO de ${evaluatedFunctions.length} funciones evaluadas originales`);
              try {
                await commandService.updateCommand(command.id, {
                  functions: evaluatedFunctions
                });
                console.log(`[ToolEvaluator] Guardado forzado completado exitosamente`);
              } catch (forceSaveError) {
                console.error(`[ToolEvaluator] Error en guardado forzado:`, forceSaveError);
              }
            }
          }
        } catch (error) {
          console.error(`[ToolEvaluator] Error obteniendo comando actualizado:`, error);
          // En caso de error, usar las funciones evaluadas originales
          updatedCommand.functions = evaluatedFunctions;
        }
        
        // Loguear para diagnóstico
        if (updatedCommand.functions && updatedCommand.functions.length > 0) {
          console.log(`[ToolEvaluator] Returning command with ${updatedCommand.functions.length} functions`);
          console.log(`[ToolEvaluator] Function statuses: ${updatedCommand.functions.map((f: any) => f.status).join(', ')}`);
        } else {
          console.log(`[ToolEvaluator] Returning command without functions`);
        }
        
        // Return results with original tools - no modifications to tools
        return {
          status: 'completed',
          results: [{
            type: 'tool_evaluation',
            content: {
              message: "Tool evaluation completed",
              updated_tools: command.tools, // Return original tools instead of modifying them
              possible_match_functions: possibleMatchCalls.length > 0 ? possibleMatchCalls : undefined
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

  /**
   * Execute selected tools from LLM response
   * @param functionCalls - Array of function calls to execute
   * @param tools - Array of available tools
   * @param commandId - ID of the command that initiated these function calls
   * @param possibleMatchFunctions - Optional array of functions with possible_match status
   * @returns Results of tool execution
   */
  async executeSelectedTools(
    functionCalls: FunctionCall[], 
    tools: any[],
    commandId: string,
    possibleMatchFunctions?: FunctionCall[]
  ): Promise<ToolExecutionResult[]> {
    console.log(`[ToolEvaluator] Starting execution of ${functionCalls.length} selected tools for command: ${commandId}`);
    
    try {
      // Filter out possible_match functions as they should not be executed
      const executableCalls = functionCalls.filter(call => call.status !== 'possible_match');
      
      if (executableCalls.length < functionCalls.length) {
        console.log(`[ToolEvaluator] Skipping ${functionCalls.length - executableCalls.length} possible_match functions`);
      }
      
      if (executableCalls.length === 0) {
        console.log(`[ToolEvaluator] No executable functions remain after filtering possible_match status`);
        
        // Even if there are no executable calls, still update context with possible_match functions
        if (possibleMatchFunctions && possibleMatchFunctions.length > 0) {
          console.log(`[ToolEvaluator] Still adding ${possibleMatchFunctions.length} possible_match functions to context`);
          await runToolExecution([], tools, commandId, possibleMatchFunctions);
        }
        
        return [];
      }
      
      // Use our new tool executor to run the tools with the command ID
      const results = await runToolExecution(executableCalls, tools, commandId, possibleMatchFunctions);
      console.log(`[ToolEvaluator] Tool execution completed with ${results.length} results`);
      return results;
    } catch (error: any) {
      console.error(`[ToolEvaluator] Error executing tools:`, error);
      throw new Error(`Failed to execute selected tools: ${error.message}`);
    }
  }
}

// Re-exportar desde las carpetas refactorizadas
export * from './executor';
export * from './updater';
export * from './types'; 