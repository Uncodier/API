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
import axios from 'axios';

// Cache para el toolset de Composio (evita múltiples inicializaciones)
let composioToolset: OpenAIToolSet | null = null;

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
 * Ejecuta una herramienta personalizada definida en customTools
 * @param toolName Nombre de la herramienta
 * @param args Argumentos para la herramienta
 * @returns Resultado de la ejecución
 */
async function executeCustomApiTool(toolName: string, args: any): Promise<any> {
  // Variable para rastrear la URL actual (para logs y manejo de errores)
  let currentUrl = '';
  
  try {
    const apiConfig = getCustomToolDefinition(toolName);
    if (!apiConfig) {
      throw new Error(`No se encontró configuración para la herramienta: ${toolName}`);
    }
    
    console.log(`[ToolExecutor] Ejecutando herramienta API personalizada: ${toolName}`);
    
    // Ya no validamos parámetros requeridos aquí, asumimos que la validación se hace en otro lugar
    
    // Preparar la URL reemplazando variables en la ruta
    let url = apiConfig.endpoint.url;
    currentUrl = url; // Guardar para manejo de errores
    
    // Comprobar si es una URL local (que comienza con /)
    if (url.startsWith('/')) {
      // En entorno de producción, usar API_BASE_URL si está definida
      if (process.env.NODE_ENV === 'production' && process.env.API_BASE_URL) {
        // Eliminar la barra inicial si API_BASE_URL ya termina con barra
        const baseUrl = process.env.API_BASE_URL.endsWith('/')
          ? process.env.API_BASE_URL.slice(0, -1)
          : process.env.API_BASE_URL;
        
        url = `${baseUrl}${url}`;
        currentUrl = url; // Actualizar URL actual
        console.log(`[ToolExecutor] URL transformada usando API_BASE_URL: ${url}`);
      } else {
        // En desarrollo o si no hay API_BASE_URL, usar localhost con IPv4 explícito
        // para evitar problemas con IPv6 (::1)
        const port = process.env.PORT || 3000;
        url = `http://127.0.0.1:${port}${url}`; // Usar IPv4 explícito en lugar de localhost
        currentUrl = url; // Actualizar URL actual
        console.log(`[ToolExecutor] URL transformada a 127.0.0.1: ${url}`);
      }
    }
    
    // Reemplazar variables en la URL como {product_id} con su valor real
    Object.keys(args).forEach(key => {
      url = url.replace(`{${key}}`, encodeURIComponent(String(args[key])));
    });
    currentUrl = url; // Actualizar URL después de reemplazos
    
    // Preparar headers
    const headers = { ...apiConfig.endpoint.headers };
    
    // Procesar autenticación si es necesaria
    if (apiConfig.endpoint.requiresAuth) {
      switch (apiConfig.endpoint.authType) {
        case 'Bearer':
          // Reemplazar tokens de plantilla con valores reales
          if (headers['Authorization'] && headers['Authorization'].includes('{{')) {
            headers['Authorization'] = headers['Authorization'].replace('{{SUPPORT_API_TOKEN}}', process.env.SUPPORT_API_TOKEN || '');
          }
          break;
        case 'ApiKey':
          // Reemplazar tokens de plantilla con valores reales
          Object.keys(headers).forEach(key => {
            if (headers[key] && typeof headers[key] === 'string' && headers[key].includes('{{')) {
              if (headers[key].includes('{{WEATHER_API_KEY}}')) {
                headers[key] = headers[key].replace('{{WEATHER_API_KEY}}', process.env.WEATHER_API_KEY || '');
              }
              // Agregar más sustituciones según sea necesario
            }
          });
          break;
        // Añadir otros tipos de autenticación según sea necesario
      }
    }
    
    // Ejecutar la llamada HTTP con reintentos
    let response: any;
    let lastError: any = null;
    const alternativePorts = [3000, 3001, 8080]; // Puertos alternativos a probar
    const alternativeHosts = ['127.0.0.1', 'localhost']; // Hosts alternativos a probar
    
    // Función auxiliar para hacer la petición HTTP basada en método
    const makeRequest = async (requestUrl: string) => {
      switch (apiConfig.endpoint.method) {
        case 'GET':
          // Para GET, añadir parámetros a la URL que no estén ya en la ruta
          const queryParams = new URLSearchParams();
          Object.keys(args).forEach(key => {
            if (!requestUrl.includes(`{${key}}`)) {
              queryParams.append(key, String(args[key]));
            }
          });
          const queryString = queryParams.toString();
          const finalUrl = queryString ? `${requestUrl}?${queryString}` : requestUrl;
          return await axios.get(finalUrl, { headers });
        case 'POST':
          return await axios.post(requestUrl, args, { headers });
        case 'PUT':
          return await axios.put(requestUrl, args, { headers });
        case 'DELETE':
          return await axios.delete(requestUrl, { headers, data: args });
        case 'PATCH':
          return await axios.patch(requestUrl, args, { headers });
        default:
          throw new Error(`Método HTTP no soportado: ${apiConfig.endpoint.method}`);
      }
    };
    
    // Intento inicial
    try {
      console.log(`[ToolExecutor] Intentando petición a: ${url}`);
      response = await makeRequest(url);
    } catch (httpError: any) {
      // Si es un error de conexión rehusada, probar combinaciones de host/puerto
      if ((httpError.code === 'ECONNREFUSED' || httpError.errno === -61) && 
         (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('::1'))) {
        
        lastError = httpError;
        let retrySuccessful = false;
        
        console.log(`[ToolExecutor] Error de conexión rechazada (${httpError.code}). Intentando alternativas...`);
        
        // Si la URL contiene ::1 (IPv6), reemplazarla por alternativas IPv4
        if (url.includes('::1')) {
          url = url.replace('::1', '127.0.0.1');
          console.log(`[ToolExecutor] Reemplazando ::1 por 127.0.0.1: ${url}`);
        }
        
        // Descomponer la URL para probar diferentes combinaciones
        let urlObj: URL;
        try {
          urlObj = new URL(url);
        } catch (e) {
          console.error(`[ToolExecutor] Error al parsear URL ${url}:`, e);
          throw httpError; // Si no podemos parsear la URL, reenviar el error original
        }
        
        const originalProtocol = urlObj.protocol; // http: o https:
        const originalPort = urlObj.port || (originalProtocol === 'https:' ? '443' : '80');
        const originalHostname = urlObj.hostname; // sin puerto
        const originalPathname = urlObj.pathname;
        const originalSearch = urlObj.search;
        
        // Crear matriz de combinaciones para probar
        let combinations: {host: string, port: string}[] = [];
        
        // Si estamos en una URL de localhost, intentar todas las combinaciones de host/puerto
        if (originalHostname === 'localhost' || originalHostname === '127.0.0.1' || originalHostname === '::1') {
          for (const host of alternativeHosts) {
            for (const port of alternativePorts) {
              // Evitar la combinación original que ya falló
              if (host === originalHostname && port.toString() === originalPort) continue;
              combinations.push({ host, port: port.toString() });
            }
          }
        } else {
          // Para URLs no-localhost, solo reintentamos con puertos alternativos
          for (const port of alternativePorts) {
            if (port.toString() === originalPort) continue;
            combinations.push({ host: originalHostname, port: port.toString() });
          }
        }
        
        // Probar cada combinación hasta que una funcione
        for (const combo of combinations) {
          try {
            urlObj.hostname = combo.host;
            urlObj.port = combo.port;
            
            const altUrl = urlObj.toString();
            console.log(`[ToolExecutor] Intentando alternativa: ${altUrl}`);
            
            response = await makeRequest(altUrl);
            currentUrl = altUrl; // Actualizar URL actual
            
            // Si llegamos aquí, el reintento fue exitoso
            retrySuccessful = true;
            console.log(`[ToolExecutor] ✅ Conexión exitosa usando: ${altUrl}`);
            
            // Actualizar la configuración para futuros intentos si estamos en desarrollo
            if (process.env.NODE_ENV !== 'production') {
              process.env.PORT = combo.port;
              console.log(`[ToolExecutor] Actualizando PORT=${combo.port} para futuros intentos`);
            }
            
            break; // Salir del bucle de reintentos
          } catch (retryError: any) {
            console.log(`[ToolExecutor] ❌ Fallo al intentar con ${combo.host}:${combo.port}: ${retryError.message}`);
            lastError = retryError;
          }
        }
        
        // Si ninguno de los reintentos tuvo éxito, lanzar el último error
        if (!retrySuccessful) {
          console.error(`[ToolExecutor] ⚠️ Todos los intentos de conexión fallaron.`);
          throw lastError;
        }
      } else {
        // Si no es un error de conexión o no es una URL local, reenviar el error
        throw httpError;
      }
    }
      
    // Si llegamos aquí, es porque la respuesta fue exitosa (código 2xx)
    // Procesar respuesta según el mapeo definido
    if (apiConfig.responseMapping && response.data) {
      const mappedResponse: Record<string, any> = {};
      
      Object.entries(apiConfig.responseMapping).forEach(([targetKey, sourcePath]) => {
        // Implementación simple para obtener valores anidados
        const pathParts = sourcePath.split('.');
        let value = response.data;
        
        for (const part of pathParts) {
          if (part.includes('[') && part.includes(']')) {
            // Manejar arrays
            const arrayName = part.substring(0, part.indexOf('['));
            const index = parseInt(part.substring(part.indexOf('[') + 1, part.indexOf(']')));
            if (value[arrayName] && Array.isArray(value[arrayName]) && value[arrayName].length > index) {
              value = value[arrayName][index];
            } else {
              value = undefined;
              break;
            }
          } else if (value && typeof value === 'object' && part in value) {
            value = value[part];
          } else {
            value = undefined;
            break;
          }
        }
        
        mappedResponse[targetKey] = value;
      });
      
      return mappedResponse;
    }
    
    // Si no hay mapeo, retornar la respuesta completa
    return response.data;
    
  } catch (error: any) {
    console.error(`[ToolExecutor] Error ejecutando herramienta API personalizada ${toolName}:`, error);
    
    // Capturar la URL para el registro de errores
    const errorUrl = error.config?.url || currentUrl || 'desconocida';
    
    // Procesar errores de respuesta HTTP específicos
    if (error.response) {
      const statusCode = error.response.status;
      const responseData = error.response.data;
      
      console.error(`[ToolExecutor] Error HTTP ${statusCode} en petición a ${errorUrl}:`, responseData);
      
      // Comprobar si tenemos un mapeo de error para este código de estado
      const apiDef = getCustomToolDefinition(toolName);
      if (apiDef?.errors && apiDef.errors[statusCode]) {
        const errorConfig = apiDef.errors[statusCode];
        
        // Extraer mensaje y código de error de la respuesta según el mapeo
        let errorMessage = 'Error desconocido';
        let errorCode = 'UNKNOWN_ERROR';
        
        // Navegar por la estructura de respuesta para encontrar el mensaje de error
        if (errorConfig.message) {
          const messageParts = errorConfig.message.split('.');
          let messageValue = responseData;
          
          for (const part of messageParts) {
            if (messageValue && typeof messageValue === 'object' && part in messageValue) {
              messageValue = messageValue[part];
            } else {
              messageValue = undefined;
              break;
            }
          }
          
          if (messageValue && typeof messageValue === 'string') {
            errorMessage = messageValue;
          }
        }
        
        // Navegar por la estructura de respuesta para encontrar el código de error
        if (errorConfig.code) {
          const codeParts = errorConfig.code.split('.');
          let codeValue = responseData;
          
          for (const part of codeParts) {
            if (codeValue && typeof codeValue === 'object' && part in codeValue) {
              codeValue = codeValue[part];
            } else {
              codeValue = undefined;
              break;
            }
          }
          
          if (codeValue && (typeof codeValue === 'string' || typeof codeValue === 'number')) {
            errorCode = String(codeValue);
          }
        }
        
        // Formar un mensaje de error significativo
        throw new Error(`${errorCode}: ${errorMessage}`);
      }
      
      // Si no hay mapeo específico, usar un mensaje genérico según el código de estado
      switch (Math.floor(statusCode / 100)) {
        case 4:
          throw new Error(`Error de cliente (${statusCode}): ${JSON.stringify(responseData)}`);
        case 5:
          throw new Error(`Error de servidor (${statusCode}): ${JSON.stringify(responseData)}`);
        default:
          throw new Error(`Error HTTP ${statusCode}: ${JSON.stringify(responseData)}`);
      }
    }
    
    // Para errores de conexión, proporcionar un mensaje más claro
    if (error.code === 'ECONNREFUSED' || error.errno === -61) {
      throw new Error(`Error de conexión: No se pudo conectar al servidor en ${errorUrl}. Verifique que el servicio esté en ejecución y que los puertos estén correctamente configurados.`);
    }
    
    // Si no es un error de respuesta HTTP específico, reenviar el error original
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