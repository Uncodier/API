/**
 * Utilidades para el manejo de logs y respuestas de API
 */

/**
 * Log de información
 */
export function logInfo(service: string, message: string, ...args: any[]): void {
  console.log(`[${service}] ${message}`, ...args);
}

/**
 * Log de errores
 */
export function logError(service: string, message: string, error?: any): void {
  console.error(`[${service}] ${message}`, error || '');
}

/**
 * Log de advertencias
 */
export function logWarning(service: string, message: string, ...args: any[]): void {
  console.warn(`[${service}] ${message}`, ...args);
}

/**
 * Log de depuración
 */
export function logDebug(service: string, message: string, ...args: any[]): void {
  if (process.env.NODE_ENV === 'development') {
    console.debug(`[${service}] ${message}`, ...args);
  }
}

/**
 * Registra los resultados de personalización en los logs de forma resumida
 * 
 * @param service El nombre del servicio que está registrando
 * @param result Los resultados de personalización
 * @param method El método HTTP utilizado (opcional)
 */
export function logPersonalizationResult(service: string, result: any, method: string = 'POST'): void {
  if (!result) {
    logWarning(service, `${method} - No hay resultados de personalización para registrar`);
    return;
  }

  const personalizations = result.personalizations || [];
  const count = personalizations.length;
  
  // Solo registrar un resumen, no detalles de cada personalización
  logInfo(service, `${method} - Resultados de personalización: ${count} modificaciones generadas`);
  
  // En modo de desarrollo, mostrar breve información de los primeros 2 elementos como muestra
  if (process.env.NODE_ENV === 'development' && count > 0) {
    const sampleSize = Math.min(2, count);
    for (let i = 0; i < sampleSize; i++) {
      const p = personalizations[i];
      logDebug(
        service, 
        `${method} - Ejemplo #${i+1}/${count}: ${p.selector} (${p.operation_type})`
      );
    }
    
    if (count > sampleSize) {
      logDebug(service, `${method} - Y ${count - sampleSize} personalizaciones más...`);
    }
  }
}

/**
 * Crea una respuesta de API estandarizada con datos y cabeceras personalizadas
 * 
 * @param data Los datos a incluir en la respuesta
 * @param status El código de estado HTTP
 * @param headers Cabeceras HTTP adicionales (opcional)
 * @returns Respuesta NextResponse formateada
 */
export function createApiResponse(data: any, status: number = 200, headers: Record<string, string> = {}): Response {
  // Preparar las cabeceras
  const responseHeaders = new Headers();
  responseHeaders.set('Content-Type', 'application/json');
  
  // Añadir cabeceras personalizadas
  Object.entries(headers).forEach(([key, value]) => {
    responseHeaders.set(key, value);
  });
  
  // Añadir metadatos a la respuesta
  const responseWithMetadata = {
    ...data,
    _metadata: {
      timestamp: new Date().toISOString(),
      status
    }
  };
  
  // Crear y devolver la respuesta
  return new Response(JSON.stringify(responseWithMetadata), {
    status,
    headers: responseHeaders
  });
} 