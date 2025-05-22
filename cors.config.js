/**
 * Configuración CORS para next.config.mjs
 * Versión ES modules para ser compatible con middleware.ts y next.config.mjs
 */

// Orígenes permitidos por entorno
const corsConfig = {
  production: {
    origins: [
      'https://salocal.site',
      'https://www.salocal.site',
      // También permitir orígenes de desarrollo en producción para pruebas
      'http://localhost:3000',
      'http://localhost:3456',
      'http://localhost:3001',
      'http://127.0.0.1:3456',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001'
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
      'http://192.168.87.64:3001',
      'http://192.168.87.64:3456',
      'http://192.168.87.79:3001',
      'http://192.168.87.79:3456'
    ]
  }
};

// Encabezados CORS permitidos
const ALLOWED_HEADERS = 'Content-Type, Authorization, X-SA-API-KEY, Accept, Origin, X-Requested-With, Access-Control-Allow-Headers, Access-Control-Request-Headers, Access-Control-Request-Method';

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
    console.log('[CORS-CONFIG] No hay origen, permitido por defecto');
    return true;
  }
  
  if (process.env.NODE_ENV !== 'production') {
    console.log('[CORS-CONFIG] Entorno no es producción, permitido por defecto');
    return true;
  }

  // Primero verificar contra la lista de orígenes permitidos
  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.includes(origin)) {
    console.log('[CORS-CONFIG] Origen encontrado en lista estática');
    return true;
  }

  // Si no está en la lista estática, verificar en la base de datos
  try {
    const { isOriginAllowedInDb } = await import('@/lib/cors/cors-db');
    const isAllowed = await isOriginAllowedInDb(origin);
    console.log(`[CORS-CONFIG] Origen ${isAllowed ? 'permitido' : 'rechazado'} por base de datos`);
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
  console.log('[CORS-CONFIG] Generando config para next.config.mjs');
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
  
  console.log(`[CORS-CONFIG] Configuración generada para ${allowedOrigins.length} orígenes`);
  return config;
};

// Exportación por defecto para ES modules
export default {
  getAllowedOrigins,
  getAllowedHeaders,
  isOriginAllowed,
  getNextJsCorsConfig
}; 