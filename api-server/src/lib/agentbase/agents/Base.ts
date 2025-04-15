/**
 * Base - Base class for all processors and components in the Agentbase framework
 */
import { DbCommand, CommandExecutionResult, ToolExecutionResult } from '../models/types';
import { MemoryStore } from '../services/MemoryStore';

/**
 * Base class for all processors and components
 */
export abstract class Base {
  readonly id: string;
  readonly name: string;
  readonly capabilities: string[];
  memoryStore: MemoryStore;

  constructor(id: string, name: string, capabilities: string[] = []) {
    this.id = id;
    this.name = name;
    this.capabilities = capabilities;
    this.memoryStore = new MemoryStore(id);
  }

  /**
   * Get ID of the base component
   */
  getId(): string {
    return this.id;
  }

  /**
   * Get name of the base component
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get capabilities of the base component
   */
  getCapabilities(): string[] {
    return this.capabilities;
  }

  /**
   * Abstract method to execute a command - must be implemented by subclasses
   */
  abstract executeCommand(command: DbCommand): Promise<CommandExecutionResult>;

  /**
   * Validate that this component has the capabilities required by the command
   */
  protected validateCommandCapabilities(command: DbCommand): boolean {
    // Check if command requires specific capabilities
    if (command.requires_capabilities && command.requires_capabilities.length > 0) {
      // Check that this component has all required capabilities
      return command.requires_capabilities.every((capability: string) => 
        this.capabilities.includes(capability)
      );
    }
    
    // If no specific capabilities required, return true
    return true;
  }

  /**
   * Execute tools from a command
   */
  protected async executeTools(tools: any[]): Promise<ToolExecutionResult[]> {
    // Default implementation returns empty array
    // Should be overridden by specific components that can execute tools
    return [];
  }
  
  /**
   * Extract token usage from Portkey response
   */
  protected extractTokenUsage(response: any): { inputTokens?: number, outputTokens?: number } {
    try {
      if (typeof response === 'object' && response !== null) {
        if (response.usage) {
          return {
            inputTokens: response.usage.prompt_tokens || response.usage.input_tokens,
            outputTokens: response.usage.completion_tokens || response.usage.output_tokens
          };
        }
      }
      
      return { inputTokens: 0, outputTokens: 0 };
    } catch (e) {
      console.error('Error extracting token usage:', e);
      return { inputTokens: 0, outputTokens: 0 };
    }
  }
  
  /**
   * Process target outputs based on tool results
   */
  async processTargets(targets: any[], toolResults: ToolExecutionResult[]): Promise<any[]> {
    // Ensure toolResults is never undefined
    const safeToolResults = toolResults || [];
    
    // Default implementation returns empty array
    // Should be overridden by specific components to process targets
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