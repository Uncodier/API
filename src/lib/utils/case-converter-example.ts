/**
 * Ejemplo de uso del CaseConverterService
 * 
 * Este archivo muestra cómo implementar APIs que aceptan tanto camelCase como snake_case
 */

import { CaseConverterService, getFlexibleProperty } from './case-converter';

// Ejemplo 1: Normalizar request data automáticamente
export function handleFlexibleRequest(requestData: any) {
  // Convertir automáticamente a snake_case para consistencia interna
  const normalizedData = CaseConverterService.normalizeRequestData(requestData, 'snake');
  
  console.log('Request original:', requestData);
  console.log('Request normalizado:', normalizedData);
  
  return normalizedData;
}

// Ejemplo 2: Extraer parámetros específicos con nombres flexibles
export function extractApiParameters(requestData: any) {
  const parameters = CaseConverterService.extractFlexibleProperties(requestData, [
    'user_id',
    'site_id', 
    'team_member_id',
    'analysis_type',
    'since_date'
  ]);
  
  console.log('Parámetros extraídos:', parameters);
  return parameters;
}

// Ejemplo 3: Validar que todas las propiedades requeridas estén presentes
export function validateRequiredFields(requestData: any, requiredFields: string[]): boolean {
  const isValid = CaseConverterService.hasRequiredProperties(requestData, requiredFields);
  
  if (!isValid) {
    console.log('Faltan campos requeridos:', requiredFields);
  }
  
  return isValid;
}

// Ejemplo 4: Mapear propiedades con múltiples nombres posibles
export function mapEmailApiRequest(requestData: any) {
  const mapping = {
    site_id: ['siteId', 'site_id'],
    user_id: ['userId', 'user_id'],
    team_member_id: ['teamMemberId', 'team_member_id', 'memberId', 'member_id'],
    analysis_type: ['analysisType', 'analysis_type', 'type'],
    since_date: ['sinceDate', 'since_date', 'from_date', 'fromDate'],
    limit: ['limit', 'max_results', 'maxResults']
  };

  const mappedData = CaseConverterService.mapFlexibleProperties(mapping, requestData);
  
  console.log('Datos mapeados:', mappedData);
  return mappedData;
}

// Ejemplo 5: Uso en una función de API real
export async function flexibleEmailAPI(request: any) {
  try {
    // 1. Extraer datos del request
    const requestData = await request.json();
    
    // 2. Validar campos requeridos (acepta cualquier formato)
    const requiredFields = ['site_id', 'user_id'];
    if (!validateRequiredFields(requestData, requiredFields)) {
      return {
        success: false,
        error: 'Faltan campos requeridos: ' + requiredFields.join(', ')
      };
    }
    
    // 3. Mapear y extraer parámetros
    const mappedParams = mapEmailApiRequest(requestData);
    
    // 4. Extraer valores específicos usando getFlexibleProperty
    const siteId = getFlexibleProperty(requestData, 'site_id');
    const userId = getFlexibleProperty(requestData, 'user_id');
    const limit = getFlexibleProperty(requestData, 'limit') || 10;
    
    // 5. Procesar la lógica de negocio...
    console.log('Procesando con:', { siteId, userId, limit });
    
    // 6. Retornar respuesta (siempre en formato consistente)
    return {
      success: true,
      site_id: siteId,
      user_id: userId,
      limit,
      message: 'Procesado exitosamente'
    };
    
  } catch (error) {
    return {
      success: false,
      error: 'Error procesando request'
    };
  }
}

// Ejemplo 6: Middleware para APIs que normaliza automáticamente
export function createFlexibleApiMiddleware(targetFormat: 'camel' | 'snake' = 'snake') {
  return (requestData: any) => {
    // Normalizar todos los datos entrantes al formato especificado
    const normalizedData = CaseConverterService.normalizeRequestData(requestData, targetFormat);
    
    // Log para debugging
    console.log(`[CaseConverter] Converted to ${targetFormat}:`, {
      original: Object.keys(requestData),
      converted: Object.keys(normalizedData)
    });
    
    return normalizedData;
  };
}

// Ejemplo de uso del middleware
const normalizeToSnake = createFlexibleApiMiddleware('snake');
const normalizeToCamel = createFlexibleApiMiddleware('camel');

// Casos de prueba
console.log('\n=== Ejemplos de uso ===\n');

// Test con datos en camelCase
const camelData = {
  userId: '123',
  teamMemberId: '456',
  analysisType: 'lead',
  sinceDate: '2024-01-01'
};

console.log('1. Datos camelCase normalizados a snake_case:');
console.log(normalizeToSnake(camelData));

// Test con datos en snake_case
const snakeData = {
  user_id: '123',
  team_member_id: '456',
  analysis_type: 'lead',
  since_date: '2024-01-01'
};

console.log('\n2. Datos snake_case normalizados a camelCase:');
console.log(normalizeToCamel(snakeData));

// Test con datos mixtos
const mixedData = {
  userId: '123',
  team_member_id: '456',
  analysisType: 'lead',
  since_date: '2024-01-01'
};

console.log('\n3. Datos mixtos normalizados:');
console.log(normalizeToSnake(mixedData)); 