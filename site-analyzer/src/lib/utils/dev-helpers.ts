/**
 * @file dev-helpers.ts
 * @description Utilidades para mejorar la experiencia de desarrollo y depuración
 * 
 * Este archivo contiene funciones auxiliares para facilitar el desarrollo,
 * depuración y documentación del código en el proyecto Site Analyzer.
 */

import { BlockInfo, StructuredAnalysisResponse } from '../types/analyzer-types';

// Definimos el tipo AnalysisData para uso interno
export interface AnalysisData extends StructuredAnalysisResponse {}

/**
 * Formatea un objeto para mostrarlo en la consola con indentación y colores
 * 
 * @param obj - El objeto a formatear
 * @param label - Etiqueta opcional para identificar el log
 * @param depth - Profundidad máxima de anidamiento (por defecto 2)
 * @returns void
 * 
 * @example
 * ```typescript
 * const data = { user: { name: 'John', age: 30 } };
 * prettyLog(data, 'User Data');
 * // [User Data] {
 * //   "user": {
 * //     "name": "John",
 * //     "age": 30
 * //   }
 * // }
 * ```
 */
export function prettyLog(obj: any, label?: string, depth: number = 2): void {
  const prefix = label ? `[${label}] ` : '';
  console.log(`${prefix}${JSON.stringify(obj, null, 2)}`);
}

/**
 * Mide el tiempo de ejecución de una función asíncrona
 * 
 * @param fn - Función asíncrona a ejecutar
 * @param label - Etiqueta para identificar la medición
 * @returns El resultado de la función ejecutada
 * 
 * @example
 * ```typescript
 * const result = await measureTime(
 *   async () => await fetchData(),
 *   'Fetch Data'
 * );
 * // [Fetch Data] Tiempo de ejecución: 235ms
 * ```
 */
export async function measureTime<T>(
  fn: () => Promise<T>,
  label: string
): Promise<T> {
  console.time(`[${label}] Tiempo de ejecución`);
  try {
    const result = await fn();
    return result;
  } finally {
    console.timeEnd(`[${label}] Tiempo de ejecución`);
  }
}

/**
 * Valida la estructura de los datos de análisis
 * 
 * @param data - Datos de análisis a validar
 * @returns Objeto con el resultado de la validación
 * 
 * @example
 * ```typescript
 * const result = validateAnalysisData(analysisData);
 * if (!result.valid) {
 *   console.error(`Datos inválidos: ${result.errors.join(', ')}`);
 * }
 * ```
 */
export function validateAnalysisData(data: any): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Verificar si es un objeto
  if (!data || typeof data !== 'object') {
    errors.push('Los datos de análisis deben ser un objeto');
    return { valid: false, errors, warnings };
  }

  // Verificar si tiene la estructura esperada
  if (data.structuredAnalysis) {
    // Caso 1: Los datos están dentro de structuredAnalysis
    validateStructure(data.structuredAnalysis, errors, warnings);
  } else if (data.site_info && data.blocks) {
    // Caso 2: Los datos están directamente en el objeto principal
    validateStructure(data, errors, warnings);
  } else if (data.result) {
    // Caso 3: Los datos están dentro de result
    if (data.result.structuredAnalysis) {
      validateStructure(data.result.structuredAnalysis, errors, warnings);
    } else if (data.result.site_info && data.result.blocks) {
      validateStructure(data.result, errors, warnings);
    } else {
      errors.push('Estructura de datos no reconocida dentro de result');
    }
  } else {
    errors.push('Estructura de datos no reconocida');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Valida la estructura interna de los datos de análisis
 * 
 * @param data - Datos a validar
 * @param errors - Array de errores a completar
 * @param warnings - Array de advertencias a completar
 * @private
 */
function validateStructure(
  data: any,
  errors: string[],
  warnings: string[]
): void {
  // Verificar site_info
  if (!data.site_info) {
    errors.push('Falta la información del sitio (site_info)');
  } else {
    if (!data.site_info.url) warnings.push('Falta la URL en site_info');
    if (!data.site_info.title) warnings.push('Falta el título en site_info');
  }

  // Verificar blocks
  if (!data.blocks) {
    errors.push('Faltan los bloques de contenido (blocks)');
  } else if (!Array.isArray(data.blocks)) {
    errors.push('blocks debe ser un array');
  } else if (data.blocks.length === 0) {
    warnings.push('El array de blocks está vacío');
  } else {
    // Verificar estructura de cada bloque
    data.blocks.forEach((block: BlockInfo, index: number) => {
      if (!block.id) warnings.push(`Bloque ${index}: falta ID`);
      if (!block.type) warnings.push(`Bloque ${index}: falta tipo`);
      if (!block.selector) warnings.push(`Bloque ${index}: falta selector`);
    });
  }
}

/**
 * Genera un ID único para un bloque basado en su tipo y posición
 * 
 * @param type - Tipo de bloque
 * @param index - Índice del bloque
 * @returns ID único para el bloque
 * 
 * @example
 * ```typescript
 * const blockId = generateBlockId('header', 0);
 * // 'header-1'
 * ```
 */
export function generateBlockId(type: string, index: number): string {
  return `${type.toLowerCase().replace(/\s+/g, '-')}-${index + 1}`;
}

/**
 * Extrae los bloques de un tipo específico de los datos de análisis
 * 
 * @param data - Datos de análisis
 * @param blockType - Tipo de bloque a extraer
 * @returns Array de bloques del tipo especificado
 * 
 * @example
 * ```typescript
 * const navBlocks = extractBlocksByType(analysisData, 'navigation');
 * console.log(`Encontrados ${navBlocks.length} bloques de navegación`);
 * ```
 */
export function extractBlocksByType(
  data: AnalysisData | undefined,
  blockType: string
): BlockInfo[] {
  if (!data || !data.blocks || !Array.isArray(data.blocks)) {
    return [];
  }

  return data.blocks.filter(block => 
    block.type.toLowerCase() === blockType.toLowerCase() || 
    block.section_type?.toLowerCase() === blockType.toLowerCase()
  );
}

/**
 * Normaliza los datos de análisis para asegurar una estructura consistente
 * 
 * @param data - Datos de análisis a normalizar
 * @returns Datos normalizados con estructura consistente
 * 
 * @example
 * ```typescript
 * const normalizedData = normalizeAnalysisData(rawData);
 * // Ahora normalizedData tiene una estructura consistente
 * ```
 */
export function normalizeAnalysisData(data: any): AnalysisData {
  let normalizedData: AnalysisData = {
    site_info: { url: '', title: '', description: '', language: '' },
    blocks: [],
    hierarchy: { main_sections: [], navigation_structure: [] },
    overview: { total_blocks: 0, primary_content_blocks: 0, navigation_blocks: 0, interactive_elements: 0 },
    metadata: { analyzed_by: '', timestamp: '', model_used: '', status: 'pending' }
  };

  // Extraer los datos según la estructura
  if (data.structuredAnalysis) {
    Object.assign(normalizedData, data.structuredAnalysis);
  } else if (data.site_info && data.blocks) {
    Object.assign(normalizedData, data);
  } else if (data.result) {
    if (data.result.structuredAnalysis) {
      Object.assign(normalizedData, data.result.structuredAnalysis);
    } else if (data.result.site_info && data.result.blocks) {
      Object.assign(normalizedData, data.result);
    }
  }

  // Asegurar que todos los bloques tengan ID
  if (normalizedData.blocks && Array.isArray(normalizedData.blocks)) {
    normalizedData.blocks = normalizedData.blocks.map((block: BlockInfo, index: number) => {
      if (!block.id) {
        block.id = generateBlockId(block.type || 'block', index);
      }
      return block;
    });

    // Actualizar contadores en overview
    normalizedData.overview.total_blocks = normalizedData.blocks.length;
    normalizedData.overview.primary_content_blocks = normalizedData.blocks.filter(
      (b: BlockInfo) => b.type === 'main' || b.type === 'content' || b.section_type === 'content'
    ).length;
    normalizedData.overview.navigation_blocks = normalizedData.blocks.filter(
      (b: BlockInfo) => b.type === 'nav' || b.type === 'navigation' || b.section_type === 'navigation'
    ).length;
    normalizedData.overview.interactive_elements = normalizedData.blocks.filter(
      (b: BlockInfo) => b.content_type === 'interactive' || 
        ((b.sub_blocks || b.subBlocks || []).some((sb: SubBlockInfo) => sb.interactive))
    ).length;
  }

  return normalizedData;
}

/**
 * Interfaz para los sub-bloques (copiada de analyzer-types para evitar errores)
 */
interface SubBlockInfo {
  type: string;
  text: string;
  selector: string;
  interactive?: boolean;
  [key: string]: any;
}

/**
 * Crea un logger con prefijo para facilitar la depuración
 * 
 * @param prefix - Prefijo para los mensajes de log
 * @returns Objeto con métodos de logging
 * 
 * @example
 * ```typescript
 * const logger = createPrefixedLogger('AnalyzerService');
 * logger.info('Iniciando análisis');
 * // [AnalyzerService] INFO: Iniciando análisis
 * ```
 */
export function createPrefixedLogger(prefix: string) {
  return {
    info: (message: string, ...args: any[]) => 
      console.log(`[${prefix}] INFO: ${message}`, ...args),
    warn: (message: string, ...args: any[]) => 
      console.warn(`[${prefix}] WARN: ${message}`, ...args),
    error: (message: string, ...args: any[]) => 
      console.error(`[${prefix}] ERROR: ${message}`, ...args),
    debug: (message: string, ...args: any[]) => 
      console.debug(`[${prefix}] DEBUG: ${message}`, ...args),
  };
} 