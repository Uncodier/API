/**
 * ProcessorRegistry - Gestiona el registro y mapeo de procesadores
 */
import { Base } from '../../agents/Base';
import { DatabaseAdapter } from '../../adapters/DatabaseAdapter';

export class ProcessorRegistry {
  private processors: Record<string, Base> = {};
  private dbUuidToProcessorId: Record<string, string> = {};

  constructor() {
    console.log('🔧 ProcessorRegistry: Inicializando registro de procesadores');
  }

  /**
   * Registra un procesador
   */
  public registerProcessor(id: string, processor: Base): void {
    this.processors[id] = processor;
    console.log(`✅ Procesador registrado: ${id} (${processor.getName()})`);
  }

  /**
   * Registra un mapeo entre UUID de la base de datos y ID interno de procesador
   */
  public registerMapping(dbUuid: string, processorId: string): void {
    this.dbUuidToProcessorId[dbUuid] = processorId;
    console.log(`🔗 Registrado mapeo de UUID ${dbUuid} a procesador ${processorId}`);
  }

  /**
   * Obtiene un procesador por su ID
   */
  public getProcessorById(id: string): Base | null {
    console.log(`🔍 Buscando procesador para ID: ${id}`);
    
    // Primero verificamos si es un ID interno
    if (this.processors[id]) {
      console.log(`✅ Encontrado procesador directo con ID: ${id}`);
      return this.processors[id];
    }
    
    // Si no, verificamos si es un UUID mapeado a un ID interno
    const internalId = this.dbUuidToProcessorId[id];
    if (internalId && this.processors[internalId]) {
      console.log(`🔍 UUID ${id} mapeado a procesador interno ${internalId}`);
      return this.processors[internalId];
    }
    
    // Si es un UUID válido, intentar buscar en todos los mapeos
    if (DatabaseAdapter.isValidUUID(id)) {
      console.log(`🔍 ID es un UUID válido (${id}), buscando mapeo aproximado...`);
      
      // Intentar encontrar si hay algún mapeo que use el inicio del UUID
      for (const [uuid, processorId] of Object.entries(this.dbUuidToProcessorId)) {
        if (uuid.startsWith(id.substring(0, 8)) || id.startsWith(uuid.substring(0, 8))) {
          console.log(`🔍 Posible coincidencia parcial: ${uuid} -> ${processorId}`);
          if (this.processors[processorId]) {
            console.log(`✅ Encontrado procesador por coincidencia parcial: ${processorId}`);
            return this.processors[processorId];
          }
        }
      }
    }
    
    // Si no encontramos coincidencia, usar el procesador por defecto
    if (this.processors['default_customer_support_agent']) {
      console.log(`⚠️ No se encontró procesador para ID ${id}, usando procesador por defecto`);
      if (DatabaseAdapter.isValidUUID(id)) {
        this.registerMapping(id, 'default_customer_support_agent');
      }
      return this.processors['default_customer_support_agent'];
    }
    
    // Último recurso: usar cualquier procesador disponible
    if (Object.keys(this.processors).length > 0) {
      const fallbackId = Object.keys(this.processors)[0];
      console.log(`⚠️ Usando procesador de fallback: ${fallbackId}`);
      return this.processors[fallbackId];
    }
    
    console.log(`❌ No se encontró procesador para ID ${id}`);
    return null;
  }

  /**
   * Obtiene todos los procesadores registrados
   */
  public getAllProcessors(): Record<string, Base> {
    return this.processors;
  }

  /**
   * Obtiene el número de mapeos registrados
   */
  public getMappingCount(): number {
    return Object.keys(this.dbUuidToProcessorId).length;
  }

  /**
   * Obtiene los IDs de los procesadores disponibles
   */
  public getProcessorIds(): string[] {
    return Object.keys(this.processors);
  }

  /**
   * Muestra información de diagnóstico sobre los mapeos y procesadores
   */
  public logDiagnosticInfo(): void {
    console.log(`ℹ️ Mapeos UUID a procesador disponibles:`, Object.keys(this.dbUuidToProcessorId).length);
    console.log(`ℹ️ Procesadores disponibles:`, Object.keys(this.processors).length);
    
    // Mostrar mapeos para debugging
    Object.entries(this.dbUuidToProcessorId).forEach(([uuid, processorId]) => {
      console.log(`ℹ️ Mapeo: ${uuid} -> ${processorId}`);
    });
    
    // Mostrar procesadores disponibles para debugging
    Object.entries(this.processors).forEach(([procId, proc]) => {
      console.log(`ℹ️ Procesador: ${procId} (${(proc as Base).getName()})`);
    });
  }
} 