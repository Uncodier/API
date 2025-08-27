/**
 * ProcessorInitializer - Clase de compatibilidad para AgentInitializer
 * 
 * Esta clase mantiene compatibilidad con código antiguo que hace referencia a ProcessorInitializer
 */
import AgentInitializer from '../agent/AgentInitializer';

/**
 * ProcessorInitializer - EDGE FUNCTIONS compatible wrapper
 * Creates fresh instances for each request instead of using singletons
 */
export class ProcessorInitializer {
  private agentInitializer: AgentInitializer;
  
  // Constructor creates fresh AgentInitializer instance
  constructor() {
    console.log('🔄 [EDGE] ProcessorInitializer: Creating fresh AgentInitializer');
    this.agentInitializer = AgentInitializer.createAndInitialize();
  }
  
  // Main method to get ProcessorInitializer instance (Edge Functions compatible)
  public static getInstance(): ProcessorInitializer {
    console.log('🔄 [EDGE] ProcessorInitializer: Creating fresh instance (no singleton in Edge)');
    return new ProcessorInitializer();
  }
  
  // Initialize - already done in constructor
  public initialize() {
    console.log('🔄 [EDGE] ProcessorInitializer: Already initialized in constructor');
    return this;
  }
  
  // Execute command using the fresh AgentInitializer instance
  public async executeCommand(command: any): Promise<any> {
    console.log('🔄 [EDGE] ProcessorInitializer: Executing command with fresh instance');
    return this.agentInitializer.executeCommand(command);
  }
  
  // Get command service from the fresh AgentInitializer instance
  public getCommandService(): any {
    console.log('🔄 [EDGE] ProcessorInitializer: Getting CommandService from fresh instance');
    return this.agentInitializer.getCommandService();
  }
}

// Export ProcessorInitializer class as the single interface
export default ProcessorInitializer;