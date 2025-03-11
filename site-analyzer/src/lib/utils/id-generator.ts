/**
 * Utilidad para generar IDs únicos para segmentos
 * 
 * Este módulo proporciona funciones para generar identificadores únicos
 * para los segmentos de audiencia, siguiendo un formato específico.
 */

/**
 * Genera un ID único para un segmento basado en su nombre
 * 
 * @param segmentName Nombre del segmento para el que se generará el ID
 * @returns ID único en formato "seg_nombre_normalizado_timestamp"
 */
export function generateSegmentId(segmentName: string): string {
  // Normalizar el nombre: convertir a minúsculas, eliminar caracteres especiales y espacios
  const normalizedName = segmentName
    .toLowerCase()
    .replace(/[^\w\s]/g, '')  // Eliminar caracteres especiales
    .replace(/\s+/g, '_')     // Reemplazar espacios con guiones bajos
    .substring(0, 30);        // Limitar longitud
  
  // Añadir timestamp para garantizar unicidad
  const timestamp = Date.now().toString(36).substring(4);
  
  // Formato: seg_nombre_normalizado_timestamp
  return `seg_${normalizedName}_${timestamp}`;
}

/**
 * Genera un ID único para un segmento con un prefijo personalizado
 * 
 * @param prefix Prefijo para el ID (por defecto "seg")
 * @param baseText Texto base para generar el ID
 * @returns ID único en formato "prefijo_texto_normalizado_timestamp"
 */
export function generateCustomId(prefix: string = 'seg', baseText: string): string {
  // Normalizar el texto base
  const normalizedText = baseText
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 20);
  
  // Añadir componente aleatorio para mayor unicidad
  const randomComponent = Math.random().toString(36).substring(2, 6);
  
  // Formato: prefijo_texto_normalizado_random_timestamp
  return `${prefix}_${normalizedText}_${randomComponent}_${Date.now().toString(36).substring(4)}`;
}

/**
 * Verifica si un ID tiene el formato correcto de segmento
 * 
 * @param id ID a verificar
 * @returns true si el ID tiene el formato correcto
 */
export function isValidSegmentId(id: string): boolean {
  // Verificar que el ID comience con "seg_" y tenga al menos 10 caracteres
  return id.startsWith('seg_') && id.length >= 10;
}

/**
 * Genera un ID único combinando un prefijo, un timestamp y un sufijo aleatorio.
 * Útil para generar IDs únicos para entidades del sistema.
 * 
 * @param prefix Prefijo para el ID
 * @returns ID único
 */
export function generateUniqueId(prefix: string = 'id'): string {
  const timestamp = Date.now().toString(36); // Timestamp en base 36
  const randomPart = Math.random().toString(36).substring(2, 8); // 6 caracteres aleatorios
  
  return `${prefix}_${timestamp}_${randomPart}`;
}

/**
 * Genera un ID único para un sitio
 * 
 * @returns ID único para un sitio con formato site_randomString
 */
export function generateSiteId(): string {
  return generateUniqueId('site');
}

/**
 * Genera un ID único para un usuario
 * 
 * @returns ID único para un usuario con formato usr_randomString
 */
export function generateUserId(): string {
  return generateUniqueId('usr');
}

/**
 * Genera un ID único para una campaña
 * 
 * @returns ID único para una campaña con formato camp_randomString
 */
export function generateCampaignId(): string {
  return generateUniqueId('camp');
} 