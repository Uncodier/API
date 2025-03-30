/**
 * Implementación del servicio de personalización de HTML basada en segmentos
 * 
 * Este servicio permite generar y aplicar personalizaciones específicas al HTML
 * de un sitio web basadas en segmentos de audiencia.
 * 
 * AVISO: Este archivo es un wrapper de compatibilidad para la nueva implementación modular.
 * Para nuevas implementaciones, utilizar directamente los módulos en src/lib/services/html-personalization/
 */

import {
  PersonalizationOptions,
  PersonalizationModification,
  PersonalizationImplementation,
  PerformanceImpact,
  DiffSummary,
  PersonalizationResponse,
  personalizeHtmlForSegment
} from './html-personalization';

// Re-exportar tipos utilizando export type
export type {
  PersonalizationOptions,
  PersonalizationModification,
  PersonalizationImplementation,
  PerformanceImpact,
  DiffSummary,
  PersonalizationResponse
};

// Exportar la función principal
export { personalizeHtmlForSegment }; 