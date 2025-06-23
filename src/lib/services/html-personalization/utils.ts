/**
 * Utilidades para el servicio de personalización HTML
 */
import { PersonalizationModification } from './types';
import { logError, logInfo } from '@/lib/utils/api-response-utils';

/**
 * Genera un ID único para personalización o modificación
 */
export function generateUniqueId(): string {
  return `id_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * Genera un ID único para una personalización
 */
export function generatePersonalizationId(index: number): string {
  return `mod_${Date.now()}_${index}`;
}

/**
 * Logs information about the formatted personalizations
 */
export function logPersonalizationsInfo(personalizations: PersonalizationModification[]): void {
  logInfo('HTML Personalization', `Formatted personalizations count: ${personalizations.length}`);
  
  personalizations.forEach((p: any, index: number) => {
    const hasAfterHtml = p.after_html !== undefined && p.after_html !== null;
    const afterHtmlLength = hasAfterHtml ? p.after_html.length : 0;
    const afterHtmlPreview = hasAfterHtml 
      ? (p.after_html.length > 50 ? p.after_html.substring(0, 50) + '...' : p.after_html) 
      : 'MISSING';
    
    logInfo('HTML Personalization', 
      `Formatted personalization #${index + 1} (${p.selector}): after_html length=${afterHtmlLength}, preview="${afterHtmlPreview}"`
    );
  });
}

/**
 * Determina el HTML resultante basado en el tipo de operación
 */
export function determineAfterHtml(personalization: any): string {
  // For remove operations, after_html should be empty
  if (personalization.operation_type === 'remove') {
    return '';
  }
  
  // For other operations, use the provided after_html or a fallback
  // Check if after_html is defined and return it as is without any manipulation
  if (personalization.after_html !== undefined && personalization.after_html !== null) {
    return personalization.after_html;
  }
  
  // Only use fallback if after_html is actually missing
  return '<div>No disponible</div>';
}

/**
 * Genera una URL de previsualización para la personalización
 */
export function generatePreviewUrl(url: string, segmentId: string, personalizationId: string): string {
  return `https://preview.uncodie.com/personalization/${personalizationId}`;
}

/**
 * Filtra opciones sensibles o grandes
 */
export function filterSensitiveOptions<T extends Record<string, any>>(options: T): Partial<T> {
  // Crear una copia para no modificar el original
  const filtered = { ...options };
  
  // Eliminar campos sensibles o grandes
  const fieldsToRemove = ['htmlContent', 'screenshot', 'originalAnalysis'];
  
  for (const field of fieldsToRemove) {
    if (field in filtered) {
      delete filtered[field as keyof T];
    }
  }
  
  return filtered;
}

/**
 * Determina si un objeto es un JSON incompleto
 */
export function isIncompleteJson(str: string): boolean {
  try {
    JSON.parse(str);
    return false;
  } catch (error: any) {
    // Verificar si el error sugiere un JSON incompleto
    const errorMessage = error.message || '';
    return (
      errorMessage.includes('Unexpected end of JSON input') ||
      errorMessage.includes('Unexpected end of input') ||
      errorMessage.includes('Unexpected token') ||
      errorMessage.includes('JSON.parse')
    );
  }
}

/**
 * Intenta extraer JSON de un string que puede contener marcado
 */
export function extractJson(input: string): any | null {
  try {
    // Intentar parsear directamente
    return JSON.parse(input);
  } catch (error) {
    // Intentar extraer JSON de markdown
    const jsonMatch = input.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (innerError) {
        return null;
      }
    }
    return null;
  }
}

/**
 * Filters out sensitive or large fields from options
 */
export function filterOptions(options: any): any {
  if (!options) {
    return {};
  }
  const filteredOptions = { ...options };
  delete filteredOptions.htmlContent;
  return filteredOptions;
}

/**
 * Determines the implementation method type
 */
export function determineImplementationMethod(method?: string): 'javascript' | 'html' | 'hybrid' {
  if (method === 'static_html') return 'html';
  if (method === 'hybrid') return 'hybrid';
  return 'javascript';
} 