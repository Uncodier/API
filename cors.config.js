/**
 * Configuración CORS para next.config.mjs
 * Versión ES modules para ser compatible con middleware.ts y next.config.mjs
 * 
 * NOTA IMPORTANTE SOBRE TWILIO WEBHOOKS:
 * Twilio no proporciona rangos específicos de IP para webhooks.
 * En su lugar, utilizan un pool dinámico de IPs y recomiendan validar
 * las requests usando el header X-Twilio-Signature.
 * 
 * Para manejar webhooks de Twilio de forma segura:
 * 1. Valida el X-Twilio-Signature header en tu endpoint
 * 2. No dependas de allowlists de IP para autenticación
 * 3. Usa HTTPS para todos los webhooks
 */

// Orígenes permitidos por entorno
const corsConfig = {
  production: {
    origins: [
      'https://docs.uncodie.com',
      'https://api.uncodie.com',
      'https://api.makinari.com',
      // También permitir orígenes de desarrollo en producción para pruebas
      'http://localhost:3000',
      'http://localhost:3456',
      'http://localhost:3001',
      'http://127.0.0.1:3456',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      // Dominios de Twilio (para casos especiales, no típico para webhooks)
      'https://twilio.com',
      'https://www.twilio.com',
      'https://webhooks.twilio.com'
    ]
  },
  development: {
    origins: [
      'http://localhost:3000',
      'http://localhost:3456', 
      'http://localhost:3001',
      'http://127.0.0.1:3456',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://192.168.87.64:3000',
      'http://192.168.87.64:3456',
      'http://192.168.87.79:3000',
      'http://192.168.87.79:3456',
      'http://192.168.0.61:3000',
      'http://192.168.0.61:3456',
      'http://192.168.0.61:3001',
      'http://192.168.0.62:3000',
      'http://192.168.0.62:3456',
      'http://192.168.0.62:3001',
      'http://192.168.0.62:7233',
      // Dominios de producción para desarrollo y testing
      'https://api.makinari.com',
      // Dominios de Twilio para desarrollo y testing
      'https://twilio.com',
      'https://www.twilio.com',
      'https://webhooks.twilio.com'
    ]
  }
};

// Encabezados CORS permitidos
const ALLOWED_HEADERS = 'Content-Type, Authorization, X-SA-API-KEY, x-api-key, x-sa-api-key, x-api-secret, Accept, Origin, X-Requested-With, Access-Control-Allow-Headers, Access-Control-Request-Headers, Access-Control-Request-Method';

/**
 * Obtiene la lista de orígenes permitidos según el entorno
 */
export const getAllowedOrigins = () => {
  const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const origins = corsConfig[environment].origins;
  return origins;
};

/**
 * Obtiene la lista de encabezados permitidos
 */
export const getAllowedHeaders = () => {
  return ALLOWED_HEADERS;
};

/**
 * Verifica si un origen está permitido
 */
export const isOriginAllowed = async (origin) => {
  // Si no hay origen o estamos en desarrollo, permitir
  if (!origin) {
    return true;
  }
  
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }

  // Primero verificar contra la lista de orígenes permitidos
  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  // Si no está en la lista estática, verificar en la base de datos
  try {
    const { isOriginAllowedInDb } = await import('@/lib/cors/cors-db');
    const isAllowed = await isOriginAllowedInDb(origin);
    return isAllowed;
  } catch (error) {
    console.error('[CORS-CONFIG] Error al verificar origen en base de datos:', error);
    return false;
  }
};

/**
 * Genera configuración CORS para next.config.mjs
 */
export const getNextJsCorsConfig = () => {
  const allowedOrigins = getAllowedOrigins();
  
  const config = allowedOrigins.map(origin => ({
    source: '/api/:path*',
    headers: [
      { key: 'Access-Control-Allow-Credentials', value: 'true' },
      { key: 'Access-Control-Allow-Origin', value: origin },
      { key: 'Access-Control-Allow-Methods', value: 'GET,DELETE,PATCH,POST,PUT,OPTIONS' },
      { key: 'Access-Control-Allow-Headers', value: ALLOWED_HEADERS },
      { key: 'Vary', value: 'Origin' }
    ]
  }));
  
  return config;
};

// Exportación por defecto para ES modules
export default {
  getAllowedOrigins,
  getAllowedHeaders,
  isOriginAllowed,
  getNextJsCorsConfig
}; 