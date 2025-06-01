/**
 * Servicio utilitario para conversión entre camelCase y snake_case
 * Permite trabajar con variables en cualquier formato de manera flexible
 */

/**
 * Convierte una cadena de camelCase a snake_case
 * @param str - Cadena en camelCase
 * @returns Cadena en snake_case
 */
export function camelToSnake(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Convierte una cadena de snake_case a camelCase
 * @param str - Cadena en snake_case
 * @returns Cadena en camelCase
 */
export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Convierte todas las claves de un objeto de camelCase a snake_case
 * @param obj - Objeto con claves en camelCase
 * @returns Objeto con claves en snake_case
 */
export function objectKeysToSnake<T = any>(obj: Record<string, any>): T {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj as T;
  }

  const converted: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = camelToSnake(key);
    
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      converted[snakeKey] = objectKeysToSnake(value);
    } else if (Array.isArray(value)) {
      converted[snakeKey] = value.map(item => 
        typeof item === 'object' && item !== null ? objectKeysToSnake(item) : item
      );
    } else {
      converted[snakeKey] = value;
    }
  }
  
  return converted as T;
}

/**
 * Convierte todas las claves de un objeto de snake_case a camelCase
 * @param obj - Objeto con claves en snake_case
 * @returns Objeto con claves en camelCase
 */
export function objectKeysToCamel<T = any>(obj: Record<string, any>): T {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj as T;
  }

  const converted: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = snakeToCamel(key);
    
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      converted[camelKey] = objectKeysToCamel(value);
    } else if (Array.isArray(value)) {
      converted[camelKey] = value.map(item => 
        typeof item === 'object' && item !== null ? objectKeysToCamel(item) : item
      );
    } else {
      converted[camelKey] = value;
    }
  }
  
  return converted as T;
}

/**
 * Busca una propiedad en un objeto, probando tanto camelCase como snake_case
 * @param obj - Objeto donde buscar
 * @param key - Clave a buscar (en cualquier formato)
 * @returns El valor encontrado o undefined
 */
export function getFlexibleProperty(obj: Record<string, any>, key: string): any {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }

  // Primero intentar con la clave tal como viene
  if (obj.hasOwnProperty(key)) {
    return obj[key];
  }

  // Intentar con camelCase
  const camelKey = snakeToCamel(key);
  if (obj.hasOwnProperty(camelKey)) {
    return obj[camelKey];
  }

  // Intentar con snake_case
  const snakeKey = camelToSnake(key);
  if (obj.hasOwnProperty(snakeKey)) {
    return obj[snakeKey];
  }

  return undefined;
}

/**
 * Establece una propiedad en un objeto, convirtiendo automáticamente a snake_case
 * @param obj - Objeto donde establecer la propiedad
 * @param key - Clave en cualquier formato
 * @param value - Valor a establecer
 * @param preferSnakeCase - Si true, convierte a snake_case; si false, mantiene camelCase
 */
export function setFlexibleProperty(
  obj: Record<string, any>, 
  key: string, 
  value: any, 
  preferSnakeCase: boolean = true
): void {
  if (!obj || typeof obj !== 'object') {
    return;
  }

  const finalKey = preferSnakeCase ? camelToSnake(key) : snakeToCamel(key);
  obj[finalKey] = value;
}

/**
 * Servicio principal para trabajar con conversión de casos
 */
export class CaseConverterService {
  /**
   * Normaliza un objeto de request para que funcione con ambos formatos
   * @param requestData - Datos del request en cualquier formato
   * @param targetFormat - Formato objetivo ('camel' | 'snake')
   * @returns Objeto normalizado
   */
  static normalizeRequestData<T = any>(
    requestData: Record<string, any>, 
    targetFormat: 'camel' | 'snake' = 'snake'
  ): T {
    if (targetFormat === 'snake') {
      return objectKeysToSnake<T>(requestData);
    } else {
      return objectKeysToCamel<T>(requestData);
    }
  }

  /**
   * Busca múltiples propiedades en un objeto con nombres flexibles
   * @param obj - Objeto donde buscar
   * @param keys - Array de claves a buscar
   * @returns Objeto con las propiedades encontradas
   */
  static extractFlexibleProperties(
    obj: Record<string, any>, 
    keys: string[]
  ): Record<string, any> {
    const result: Record<string, any> = {};
    
    for (const key of keys) {
      const value = getFlexibleProperty(obj, key);
      if (value !== undefined) {
        result[key] = value;
      }
    }
    
    return result;
  }

  /**
   * Valida si un objeto tiene todas las propiedades requeridas (en cualquier formato)
   * @param obj - Objeto a validar
   * @param requiredKeys - Claves requeridas
   * @returns true si todas las propiedades están presentes
   */
  static hasRequiredProperties(
    obj: Record<string, any>, 
    requiredKeys: string[]
  ): boolean {
    return requiredKeys.every(key => getFlexibleProperty(obj, key) !== undefined);
  }

  /**
   * Crea un mapeador de propiedades que acepta ambos formatos
   * @param mapping - Mapeo de propiedades { internalKey: [possibleExternalKeys] }
   * @param sourceObj - Objeto fuente
   * @returns Objeto mapeado
   */
  static mapFlexibleProperties(
    mapping: Record<string, string[]>,
    sourceObj: Record<string, any>
  ): Record<string, any> {
    const result: Record<string, any> = {};
    
    for (const [internalKey, possibleKeys] of Object.entries(mapping)) {
      for (const possibleKey of possibleKeys) {
        const value = getFlexibleProperty(sourceObj, possibleKey);
        if (value !== undefined) {
          result[internalKey] = value;
          break; // Usar el primer valor encontrado
        }
      }
    }
    
    return result;
  }
}

export default CaseConverterService; 