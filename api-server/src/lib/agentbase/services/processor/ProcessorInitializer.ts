/**
 * ProcessorInitializer - Clase de compatibilidad para AgentInitializer
 * 
 * Esta clase mantiene compatibilidad con código antiguo que hace referencia a ProcessorInitializer
 */
import AgentInitializer from '../agent/AgentInitializer';

/**
 * ProcessorInitializer es un wrapper alrededor de AgentInitializer.
 * Proporciona la misma interfaz de AgentInitializer para mantener compatibilidad
 * con el código existente.
 */
export class ProcessorInitializer {
  private static instance: ProcessorInitializer;
  
  // Constructor privado que utiliza AgentInitializer
  private constructor() { }
  
  // Obtener la instancia única
  public static getInstance(): ProcessorInitializer {
    if (!ProcessorInitializer.instance) {
      ProcessorInitializer.instance = new ProcessorInitializer();
    }
    return ProcessorInitializer.instance;
  }
  
  // Inicializar usando AgentInitializer
  public initialize() {
    console.log('🔄 [ProcessorInitializer] Inicializando utilizando directamente AgentInitializer');
    return AgentInitializer.initialize();
  }
  
  // Ejecutar un comando usando AgentInitializer directamente sin conversiones
  public async executeCommand(command: any): Promise<any> {
    console.log('🔄 [ProcessorInitializer] Ejecutando comando directamente sin conversiones');
    return AgentInitializer.executeCommand(command);
  }
  
  // Obtener el servicio de comandos de AgentInitializer
  public getCommandService(): any {
    console.log('🔄 [ProcessorInitializer] Obteniendo CommandService sin conversiones');
    return AgentInitializer.getCommandService();
  }
}

// Crear y exportar la instancia única
export const processorInitializerInstance = ProcessorInitializer.getInstance();

// Crear una instancia del getter en la instancia del singleton
// Este truco permite que el código que usa ProcessorInitializer.getInstance() siga funcionando
// al mismo tiempo que mantenemos la nueva forma de importar la instancia directamente
(processorInitializerInstance as any).getInstance = function() {
  return processorInitializerInstance;
};

// Exportar la instancia por defecto
export default processorInitializerInstance;