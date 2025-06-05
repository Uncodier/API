/**
 * Módulo para la ejecución de herramientas seleccionadas
 * 
 * Este módulo proporciona la funcionalidad para ejecutar las herramientas
 * que han sido seleccionadas por el ToolEvaluator.
 */
import { FunctionCall, ToolExecutionResult } from '../types';
import { ToolsMap } from './toolsMap';
import { hasCustomTool, getCustomToolDefinition } from './customToolsMap';
import { OpenAIToolSet } from "composio-core";
import { WorkflowService } from '../../../../services/workflow-service';

// Interfaz para el input del workflow
interface ExecuteToolWorkflowInput {
  toolName: string;
  args: Record<string, any>;
  apiConfig: any;
  environment?: Record<string, string>;
}

// Interfaz para el resultado del workflow
interface ExecuteToolWorkflowResult {
  success: boolean;
  data?: any;
  error?: string;
  statusCode?: number;
  url?: string;
}

// Helper function para debug de headers
function debugHeaders(headers: Record<string, string>, context: string) {
  console.log(`[ToolExecutor] ${context} - Headers debug:`);
  Object.keys(headers).forEach(key => {
    if (key.toLowerCase().includes('auth') || key.toLowerCase().includes('api')) {
      const value = headers[key];
      const maskedValue = value ? `${value.substring(0, 10)}...` : 'EMPTY';
      console.log(`[ToolExecutor]   ${key}: ${maskedValue}`);
    } else {
      console.log(`[ToolExecutor]   ${key}: ${headers[key]}`);
    }
  });
}

// Cache para el toolset de Composio (evita múltiples inicializaciones)
let composioToolset: OpenAIToolSet | null = null;

// Instancia del WorkflowService (singleton)
const workflowService = WorkflowService.getInstance();

// Inicializar el toolset de Composio si es necesario
async function getComposioToolset(): Promise<OpenAIToolSet> {
  if (!composioToolset) {
    try {
      composioToolset = new OpenAIToolSet({
        // Opciones de configuración si son necesarias
      });
      console.log(`[ToolExecutor] Composio toolset inicializado correctamente`);
    } catch (error: any) {
      console.error(`[ToolExecutor] Error inicializando Composio toolset:`, error);
      throw new Error(`Failed to initialize Composio: ${error.message}`);
    }
  }
  return composioToolset;
}

/**
 * Ejecuta una acción a través de Composio
 * @param functionName Nombre de la función/acción a ejecutar
 * @param args Argumentos para la acción
 * @returns Resultado de la ejecución de la acción
 */
async function executeComposioAction(functionName: string, args: any): Promise<any> {
  try {
    console.log(`[ToolExecutor] Ejecutando acción Composio: ${functionName}`);
    
    const toolset = await getComposioToolset();
    
    // Ejecutar la acción en Composio
    const result = await toolset.executeAction({
      action: functionName,
      params: args,
      // entityId: opcional, si se necesita especificar un ID diferente al predeterminado
    });
    
    if (result.successful) {
      console.log(`[ToolExecutor] Acción Composio ejecutada con éxito: ${functionName}`);
      return result.data;
    } else {
      console.error(`[ToolExecutor] Error en acción Composio: ${functionName}`, result.error);
      throw new Error(result.error || `Failed to execute Composio action: ${functionName}`);
    }
  } catch (error: any) {
    console.error(`[ToolExecutor] Error ejecutando acción Composio ${functionName}:`, error);
    throw error;
  }
}

/**
 * Ejecuta una herramienta personalizada usando Temporal Workflow
 * @param toolName Nombre de la herramienta
 * @param args Argumentos para la herramienta
 * @returns Resultado de la ejecución
 */
async function executeCustomApiTool(toolName: string, args: any): Promise<any> {
  try {
    const apiConfig = getCustomToolDefinition(toolName);
    if (!apiConfig) {
      throw new Error(`No se encontró configuración para la herramienta: ${toolName}`);
    }
    
    console.log(`[ToolExecutor] Ejecutando herramienta via Temporal Workflow: ${toolName}`);
    
    // Preparar input para el workflow
    const workflowInput: ExecuteToolWorkflowInput = {
      toolName,
      args,
      apiConfig,
      environment: {
        NODE_ENV: process.env.NODE_ENV || 'development',
        API_BASE_URL: process.env.API_BASE_URL || '',
        PORT: process.env.PORT || '3000',
        SERVICE_API_KEY: process.env.SERVICE_API_KEY || '',
        SUPPORT_API_TOKEN: process.env.SUPPORT_API_TOKEN || '',
        WEATHER_API_KEY: process.env.WEATHER_API_KEY || '',
      }
    };
    
    // Opciones del workflow
    const workflowOptions = {
      taskQueue: process.env.WORKFLOW_TASK_QUEUE || 'execute-tool-queue',
      workflowId: `execute-tool-${toolName}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      async: false, // Esperamos el resultado
      retryAttempts: 3,
      priority: 'medium' as const
    };
    
    console.log(`[ToolExecutor] Iniciando workflow para ${toolName}, ID: ${workflowOptions.workflowId}`);
    
    // Ejecutar workflow usando el servicio existente
    const result = await workflowService.executeWorkflow(
      'executeToolWorkflow',
      workflowInput,
      workflowOptions
    );
    
    console.log(`[ToolExecutor] Resultado completo del workflow para ${toolName}:`, JSON.stringify(result, null, 2));
    
    // Verificar si el workflow fue exitoso
    if (result.success) {
      console.log(`[ToolExecutor] Workflow ejecutado exitosamente para ${toolName}`);
      
      // Extraer los datos del resultado del workflow
      // El resultado puede tener diferentes estructuras dependiendo del tipo de respuesta
      if (result.data) {
        console.log(`[ToolExecutor] Datos extraídos del workflow para ${toolName}:`, JSON.stringify(result.data, null, 2));
        return result.data;
      } else {
        // Si no hay datos específicos, retornar indicador de éxito
        console.log(`[ToolExecutor] Workflow exitoso pero sin datos específicos para ${toolName}`);
        return { success: true, message: `Tool ${toolName} executed successfully` };
      }
    } else {
      // El workflow falló - extraer información de error
      let errorMessage = `Workflow failed for ${toolName}`;
      
      // Intentar extraer detalles del error dependiendo de la estructura
      if (result.error) {
        if (typeof result.error === 'string') {
          errorMessage = result.error;
        } else if (result.error.message) {
          errorMessage = result.error.message;
        } else {
          errorMessage = JSON.stringify(result.error);
        }
      } else if (result.failure) {
        // Manejar estructura de falla de Temporal
        if (result.failure.message) {
          errorMessage = result.failure.message;
        }
        
        // Si hay información de causa, extraerla también
        if (result.failure.cause && result.failure.cause.message) {
          errorMessage = result.failure.cause.message;
        }
      } else if (result.type && result.type.includes('Failed')) {
        // Manejar otros tipos de fallas
        errorMessage = `Workflow execution failed: ${result.type}`;
      }
      
      console.error(`[ToolExecutor] Error detallado en workflow para ${toolName}:`, errorMessage);
      throw new Error(errorMessage);
    }
    
  } catch (error: any) {
    console.error(`[ToolExecutor] Error ejecutando herramienta via workflow ${toolName}:`, error);
    
    // Si es un error de Temporal, proporcionar contexto adicional
    if (error.message && (error.message.includes('workflow') || error.message.includes('temporal'))) {
      throw new Error(`Temporal workflow error for ${toolName}: ${error.message}`);
    }
    
    // Si es un error de conexión a Temporal, sugerir verificar configuración
    if (error.code === 'ECONNREFUSED' || error.message.includes('connection')) {
      throw new Error(`Cannot connect to Temporal server for ${toolName}. Please verify TEMPORAL_SERVER_URL and network connectivity.`);
    }
    
    throw error;
  }
}

/**
 * Execute the selected tools from the tool evaluator response
 * @param functionCalls - Array of function calls to execute
 * @param toolsMap - Map of tool names to their implementation functions
 * @returns Results of tool execution
 */
export async function executeTools(
  functionCalls: FunctionCall[],
  toolsMap: ToolsMap
): Promise<ToolExecutionResult[]> {
  console.log(`[ToolExecutor] Executing ${functionCalls.length} tools`);
  
  const results: ToolExecutionResult[] = [];
  
  // Registrar solo las herramientas que serán utilizadas
  const requiredTools = functionCalls.map(call => call.name || 'unknown_function').filter(name => name !== 'unknown_function');
  console.log(`[ToolExecutor] Required tools for execution: ${requiredTools.join(', ') || 'none'}`);
  
  for (const call of functionCalls) {
    try {
      // Obtener el nombre y argumentos de la función (ahora en la raíz)
      const functionName = call.name || 'unknown_function';
      const functionArgs = call.arguments || '{}';
      
      console.log(`[ToolExecutor] Processing function call: ${functionName}`);
      
      // Preservar el ID original para correlacionar resultados
      const callId = call.id || `call_${Math.random().toString(36).substring(2, 8)}`;
      
      // Validar que el nombre de la función sea válido
      if (!functionName || functionName === 'unknown_function') {
        console.error(`[ToolExecutor] Invalid or missing function name in call ID: ${callId}`);
        results.push({
          id: callId,
          status: 'error',
          error: `Invalid or missing function name`,
          output: null,
          function_name: functionName, // Nombre real o indicador de falta
          arguments: functionArgs // Preservar argumentos originales
        });
        continue;
      }
      
      // Parse arguments if they are in string format
      let parsedArgs = {};
      try {
        if (typeof functionArgs === 'string') {
          parsedArgs = JSON.parse(functionArgs);
        } else if (typeof functionArgs === 'object') {
          parsedArgs = functionArgs;
        }
      } catch (error: any) {
        console.error(`[ToolExecutor] Error parsing arguments for ${functionName}:`, error);
        results.push({
          id: callId,
          status: 'error',
          error: `Error parsing arguments: ${error.message}`,
          output: null,
          function_name: functionName, // Preservar nombre original de la función
          arguments: functionArgs // Preservar argumentos originales
        });
        continue;
      }
      
      let output: any = null;
      let success = false;
      let errorMessage = '';
      
      try {
        // 1. Primero intentar buscar en el mapa de herramientas principales
        const toolFunction = toolsMap[functionName];
        
        // 2. Si existe una implementación en el mapa principal, ejecutarla
        if (toolFunction) {
          console.log(`[ToolExecutor] Executing tool from toolsMap: ${functionName}`);
          output = await toolFunction(parsedArgs);
          success = true;
        } 
        // 3. Si no existe pero es una herramienta personalizada, ejecutarla mediante la definición API
        else if (hasCustomTool(functionName)) {
          console.log(`[ToolExecutor] Executing custom API tool: ${functionName}`);
          output = await executeCustomApiTool(functionName, parsedArgs);
          success = true;
        }
        // 4. Si ninguna de las anteriores, intentar con Composio
        else {
          console.log(`[ToolExecutor] No se encontró implementación para ${functionName}, intentando con Composio`);
          try {
            output = await executeComposioAction(functionName, parsedArgs);
            success = true;
          } catch (composioError: any) {
            errorMessage = `Composio action failed: ${composioError.message}`;
            console.error(`[ToolExecutor] Error en Composio:`, composioError);
            throw new Error(errorMessage);
          }
        }
        
        // Registrar resultado exitoso
        if (success) {
          results.push({
            id: callId,
            function_name: functionName,
            arguments: functionArgs,
            status: 'success',
            error: null,
            output: output || `Executed ${functionName} successfully`
          });
        }
      } catch (execError: any) {
        // Capturar errores de ejecución específicos
        console.error(`[ToolExecutor] Error executing tool ${functionName}:`, execError);
        results.push({
          id: callId,
          function_name: functionName,
          arguments: functionArgs,
          status: 'error',
          error: execError.message || errorMessage || `Error executing ${functionName}`,
          output: null
        });
      }
      
    } catch (error: any) {
      console.error(`[ToolExecutor] Error executing tool:`, error);
      
      // Recuperar o generar un ID para correlacionar resultados
      const callId = call.id || `call_${Math.random().toString(36).substring(2, 8)}`;
      
      // Usar información de la raíz si está disponible, con fallbacks
      const functionName = call.name || 'unknown_function';
      const functionArgs = call.arguments || '{}';
      
      results.push({
        id: callId,
        status: 'error',
        error: error.message || 'Unknown error during execution',
        output: null,
        function_name: functionName,
        arguments: functionArgs
      });
    }
  }
  
  console.log(`[ToolExecutor] Completed execution of ${functionCalls.length} tools`);
  
  // Mostrar resumen detallado para cada resultado
  console.log(`[ToolExecutor] 📊 Resumen de resultados de ejecución:`);
  for (const result of results) {
    const statusEmoji = result.status === 'success' ? '✅' : '❌';
    console.log(`[ToolExecutor] ${statusEmoji} Función: ${result.function_name} (ID: ${result.id})`);
    console.log(`[ToolExecutor]    Status: ${result.status}`);
    if (result.error) {
      // Extraer solo la parte importante del mensaje de error
      let errorMsg = result.error;
      try {
        // Si es un JSON, intentar extraer el mensaje
        const errorObj = JSON.parse(result.error);
        errorMsg = errorObj.message || errorObj.reason || result.error;
      } catch (e) {
        // No es JSON, usar como está
      }
      console.log(`[ToolExecutor]    Error: ${errorMsg.length > 100 ? errorMsg.substring(0, 100) + '...' : errorMsg}`);
    }
    if (result.output) {
      const outputStr = typeof result.output === 'string' 
        ? result.output 
        : JSON.stringify(result.output);
      console.log(`[ToolExecutor]    Output: ${outputStr.length > 50 ? outputStr.substring(0, 50) + '...' : outputStr}`);
    }
  }
  
  return results;
} 