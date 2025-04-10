/**
 * Base Agent Abstract Class
 */
import { DbCommand, CommandExecutionResult, ToolExecutionResult } from '../models/types';
import { MemoryStore } from '../services/MemoryStore';

export abstract class BaseAgent {
  id: string;
  name: string;
  capabilities: string[];
  memoryStore: MemoryStore;

  constructor(id: string, name: string, capabilities: string[] = []) {
    this.id = id;
    this.name = name;
    this.capabilities = capabilities;
    this.memoryStore = new MemoryStore(id);
  }

  /**
   * Validates that a command can be executed by this agent
   */
  validateCommandCapabilities(command: DbCommand): boolean {
    // If no specific capabilities are required, allow execution
    if (!command.requires_capabilities || command.requires_capabilities.length === 0) {
      return true;
    }

    // Check if agent has all required capabilities
    return command.requires_capabilities.every((capability: string) => 
      this.capabilities.includes(capability)
    );
  }

  /**
   * Abstract method that must be implemented by all agent types
   */
  abstract executeCommand(command: DbCommand): Promise<CommandExecutionResult>;
  
  /**
   * Helper method to execute tools in sequence
   */
  async executeTools(tools: any[]): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    
    for (const tool of tools) {
      try {
        // Update tool status to running
        tool.status = 'running';
        
        // Execute the tool
        const result = await this.executeTool(tool);
        
        // Mark as completed and save result
        tool.status = 'completed';
        results.push({
          tool: tool.name,
          status: 'completed',
          result
        });
      } catch (error: any) {
        tool.status = 'failed';
        results.push({
          tool: tool.name,
          status: 'failed',
          error: error.message
        });
      }
    }
    
    return results;
  }
  
  /**
   * Executes a single tool
   */
  async executeTool(tool: any): Promise<any> {
    // Tool execution implementation - should be overridden by specific agents
    throw new Error(`Tool execution not implemented for tool: ${tool.name}`);
  }
  
  /**
   * Process target outputs based on tool results
   */
  async processTargets(targets: any[], toolResults: ToolExecutionResult[]): Promise<any[]> {
    // Default implementation returns empty array
    // Should be overridden by specific agents to process targets
    return targets.map(target => {
      // Create a basic result object based on target type
      const targetType = Object.keys(target)[0];
      return {
        type: targetType,
        content: null
      };
    });
  }

  /**
   * Consult supervisors for approval or modification of results
   */
  async consultSupervisors(supervisors: any[], results: any[]): Promise<any[]> {
    // Default implementation returns results without modifications
    // Should be overridden by specific agents to implement supervision
    return results;
  }
} 