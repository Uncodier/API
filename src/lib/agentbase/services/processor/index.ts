/**
 * Exporta todos los servicios relacionados con procesadores
 */
import ProcessorInitializer from './ProcessorInitializer';
import ProcessorConfigurationService from './ProcessorConfigurationService';
import { ProcessorFactory } from './ProcessorFactory';
import { ProcessorRegistry } from './ProcessorRegistry';

export {
  ProcessorInitializer,
  ProcessorConfigurationService,
  ProcessorFactory,
  ProcessorRegistry
};

// Exportación por defecto del inicializador para mantener compatibilidad
export default ProcessorInitializer; 