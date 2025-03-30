/**
 * Archivo de exportación de utilidades
 * 
 * Este archivo exporta todas las utilidades disponibles en la carpeta utils
 * para facilitar su importación desde otros módulos.
 */

import { v4 as uuidv4 } from 'uuid';
export { generateUniqueId, generateSegmentId, generateSiteId, generateUserId, generateCampaignId } from './id-generator';

// Exportando funciones de generación de IDs
export { uuidv4 }; 

// Exportando utilidades para sanitizar código JavaScript
export { 
  sanitizeJsCode, 
  createSafePersonalizationScript, 
  parsePersonalizationCode,
  applyPersonalizations,
  applyPersonalizationCode
} from './js-sanitizer'; 