import { isIncompleteJson, attemptJsonRepair } from './continuation-service';

interface ContinuationClientOptions {
  baseUrl?: string;
  defaultModelType?: 'anthropic' | 'openai' | 'gemini';
  defaultModelId?: string;
  defaultSiteUrl?: string;
  defaultTimeout?: number;
  defaultMaxRetries?: number;
  debugMode?: boolean;
}

interface ContinuationRequest {
  incompleteJson: string;
  modelType?: 'anthropic' | 'openai' | 'gemini';
  modelId?: string;
  siteUrl?: string;
  includeScreenshot?: boolean;
  timeout?: number;
  maxRetries?: number;
}

interface ContinuationResponse {
  success: boolean;
  completeJson?: any;
  error?: string;
  retries?: number;
  message?: string;
}

/**
 * Cliente para el servicio de continuación de JSON
 * 
 * Este cliente facilita el uso del servicio de continuación desde cualquier parte de la aplicación.
 */
export class ContinuationClient {
  private baseUrl: string;
  private defaultModelType: 'anthropic' | 'openai' | 'gemini';
  private defaultModelId: string;
  private defaultSiteUrl: string;
  private defaultTimeout: number;
  private defaultMaxRetries: number;
  private debugMode: boolean;

  constructor(options: ContinuationClientOptions = {}) {
    this.baseUrl = options.baseUrl || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');
    this.defaultModelType = options.defaultModelType || 'anthropic';
    this.defaultModelId = options.defaultModelId || 'claude-3-opus-20240229';
    this.defaultSiteUrl = options.defaultSiteUrl || 'https://example.com';
    this.defaultTimeout = options.defaultTimeout || 90000;
    this.defaultMaxRetries = options.defaultMaxRetries || 3;
    this.debugMode = options.debugMode || false;
  }

  /**
   * Construye una URL absoluta de manera segura
   * 
   * @param path Ruta relativa (por ejemplo, '/api/ai/text/continuation')
   * @returns URL absoluta como string
   */
  private buildUrl(path: string): string {
    try {
      // Intentar construir una URL válida
      const url = new URL(path, this.baseUrl);
      return url.toString();
    } catch (error) {
      console.error(`[Continuation Client] Error al construir URL (${this.baseUrl}, ${path}):`, error);
      
      // Fallback: concatenar manualmente asegurándose de que haya un solo '/'
      const baseWithSlash = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
      const pathWithoutSlash = path.startsWith('/') ? path.substring(1) : path;
      return `${baseWithSlash}${pathWithoutSlash}`;
    }
  }

  /**
   * Verifica si un JSON está incompleto
   * 
   * @param jsonString String JSON a verificar
   * @returns true si el JSON está incompleto, false si es válido
   */
  public isIncomplete(jsonString: string): boolean {
    return isIncompleteJson(jsonString);
  }

  /**
   * Intenta reparar un JSON incompleto sin usar IA
   * 
   * @param incompleteJson JSON incompleto
   * @returns JSON reparado o null si no se pudo reparar
   */
  public attemptRepair(incompleteJson: string): any | null {
    return attemptJsonRepair(incompleteJson);
  }

  /**
   * Continúa la generación de un JSON incompleto usando el servicio de API
   * 
   * @param request Solicitud de continuación
   * @returns Respuesta con el JSON completo o un error
   */
  public async continueGeneration(request: ContinuationRequest): Promise<ContinuationResponse> {
    if (this.debugMode) {
      console.log('[Continuation Client] Continuing JSON generation with request:', request);
    }
    
    // Verificar si el JSON ya es válido
    if (!this.isIncomplete(request.incompleteJson)) {
      if (this.debugMode) {
        console.log('[Continuation Client] The provided JSON is already valid');
      }
      
      try {
        const parsedJson = JSON.parse(request.incompleteJson);
        return {
          success: true,
          completeJson: parsedJson,
          message: 'The provided JSON is already valid'
        };
      } catch (error) {
        // Esto no debería ocurrir ya que isIncomplete ya verificó que es válido
        console.error('[Continuation Client] Unexpected error parsing valid JSON:', error);
      }
    }
    
    // Intentar reparar el JSON primero (solución rápida)
    const repairedJson = this.attemptRepair(request.incompleteJson);
    if (repairedJson) {
      if (this.debugMode) {
        console.log('[Continuation Client] Successfully repaired JSON without API');
      }
      
      return {
        success: true,
        completeJson: repairedJson,
        message: 'JSON was repaired without API assistance'
      };
    }
    
    // Preparar la solicitud para la API
    const apiRequest = {
      incompleteJson: request.incompleteJson,
      modelType: request.modelType || this.defaultModelType,
      modelId: request.modelId || this.defaultModelId,
      siteUrl: request.siteUrl || this.defaultSiteUrl,
      includeScreenshot: request.includeScreenshot || false,
      timeout: request.timeout || this.defaultTimeout,
      maxRetries: request.maxRetries || this.defaultMaxRetries
    };
    
    if (this.debugMode) {
      console.log('[Continuation Client] Sending request to API:', apiRequest);
    }
    
    try {
      // Determinar si estamos en el cliente o en el servidor
      const isServer = typeof window === 'undefined';
      const apiUrl = this.buildUrl('/api/ai/text/continuation');
      
      if (this.debugMode) {
        console.log(`[Continuation Client] Sending request to ${apiUrl} (${isServer ? 'server' : 'client'})`);
      }
      
      // Add a longer timeout for large responses
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, apiRequest.timeout);
      
      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(apiRequest),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[Continuation Client] Error HTTP ${response.status}:`, errorText);
          return {
            success: false,
            error: `Error HTTP ${response.status}: ${errorText}`,
            message: 'API request failed'
          };
        }
        
        const result = await response.json();
        
        if (this.debugMode) {
          console.log('[Continuation Client] Received response from API:', result);
        }
        
        return result;
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        
        // Check if this was an abort error (timeout)
        if (fetchError.name === 'AbortError') {
          console.error(`[Continuation Client] Request timed out after ${apiRequest.timeout}ms`);
          return {
            success: false,
            error: `Request timed out after ${apiRequest.timeout}ms`,
            message: 'API request timed out'
          };
        }
        
        console.error('[Continuation Client] Error calling continuation API:', fetchError);
        return {
          success: false,
          error: `Error calling continuation API: ${fetchError.message || 'Unknown error'}`,
          message: 'API request failed'
        };
      }
    } catch (error: any) {
      console.error('[Continuation Client] Error calling continuation API:', error);
      return {
        success: false,
        error: `Error calling continuation API: ${error.message || 'Unknown error'}`,
        message: 'API request failed'
      };
    }
  }
}

// Exportar una instancia por defecto para facilitar el uso
export const continuationClient = new ContinuationClient({
  defaultTimeout: 90000, // Increased default timeout to 90 seconds
});

/**
 * Función de utilidad para continuar la generación de un JSON incompleto
 * 
 * @param incompleteJson JSON incompleto
 * @param modelType Tipo de modelo a utilizar
 * @param modelId ID del modelo a utilizar
 * @param siteUrl URL del sitio para contexto
 * @param timeout Timeout en milisegundos (default: 90000)
 * @returns Respuesta con el JSON completo o un error
 */
export async function continueIncompleteJson(
  incompleteJson: string,
  modelType: 'anthropic' | 'openai' | 'gemini' = 'anthropic',
  modelId: string = 'claude-3-opus-20240229',
  siteUrl: string = 'https://example.com',
  timeout: number = 90000 // Increased from 45000 to 90000
): Promise<ContinuationResponse> {
  return continuationClient.continueGeneration({
    incompleteJson,
    modelType,
    modelId,
    siteUrl,
    timeout
  });
} 