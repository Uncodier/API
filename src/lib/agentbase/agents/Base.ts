/**
 * Base - Base class for all processors and components in the Agentbase framework
 */
import { DbCommand, CommandExecutionResult, ToolExecutionResult } from '../models/types';
import { MemoryStore } from '../services/storage/MemoryStore';

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
   * Get backstory of the base component (if any)
   */
  getBackstory(): string | undefined {
    return undefined;
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
   * Execute tools from function calls in the command
   * This is the new format that should be used instead of executeTools
   */
  protected async executeFunctions(functions: any[]): Promise<ToolExecutionResult[]> {
    // Default implementation converts function calls to tool format and calls executeTools
    if (!functions || functions.length === 0) {
      return [];
    }
    
    // Convert function calls to tool format
    const tools = functions.map(func => {
      // Check if the function is in the new format
      if (func.type === 'function' && func.function && func.function.name) {
        // Parse the arguments string to an object
        let parameters = {};
        try {
          parameters = JSON.parse(func.function.arguments || '{}');
        } catch (e) {
          console.error(`Error parsing function arguments: ${e}`);
        }
        
        // Return in the tool format
        return {
          name: func.function.name,
          parameters
        };
      }
      // If it's already in the old format, return as is
      return func;
    });
    
    // Call the existing executeTools method
    return this.executeTools(tools);
  }
  
  /**
   * Extract token counts and provider-reported accounting metadata without estimating cost.
   */
  protected extractTokenUsage(response: any): {
    inputTokens?: number; outputTokens?: number; usage?: Record<string, unknown>;
    cost?: number; cost_details?: Record<string, unknown>; is_byok?: boolean;
    generationId?: string; provider?: string; model?: string;
  } {
    try {
      const usage = response?.usage ?? response?.metadata?.usage ?? response?.content?.usage;
      const generationId = response?.generationId ?? response?.id;
      const provider = response?.modelInfo?.provider ?? response?.provider;
      const model = response?.modelInfo?.model ?? response?.model;
      const metadata = {
        ...(usage ? { usage } : {}),
        ...(typeof usage?.cost === 'number' && Number.isFinite(usage.cost) ? { cost: usage.cost } : {}),
        ...(usage?.cost_details !== undefined ? { cost_details: usage.cost_details } : {}),
        ...(typeof usage?.is_byok === 'boolean' ? { is_byok: usage.is_byok } : {}),
        ...(generationId ? { generationId } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      };
      
      if (typeof response === 'object' && response !== null) {
        // Try to extract from usage field
        if (response.usage) {
          // Check if standard OpenAI/Anthropic format
          if (response.usage.prompt_tokens !== undefined || response.usage.input_tokens !== undefined ||
              response.usage.promptTokens !== undefined || response.usage.completion_tokens !== undefined ||
              response.usage.output_tokens !== undefined || response.usage.completionTokens !== undefined) {
            const inputTokens = response.usage.prompt_tokens ?? response.usage.input_tokens ?? response.usage.promptTokens ?? 0;
            const outputTokens = response.usage.completion_tokens ?? response.usage.output_tokens ?? response.usage.completionTokens ?? 0;
            console.log(`[Base] Tokens detectados de usage estándar: input=${inputTokens}, output=${outputTokens}`);
            return { inputTokens, outputTokens, ...metadata };
          }
        }
        
        // Try to extract from usageMetadata (Gemini format)
        if (response.usageMetadata) {
          const inputTokens = response.usageMetadata.promptTokenCount || 0;
          const outputTokens = response.usageMetadata.candidatesTokenCount || 0;
          console.log(`[Base] Tokens detectados de usageMetadata: input=${inputTokens}, output=${outputTokens}`);
          return { inputTokens, outputTokens, ...metadata };
        }
        
        // Try to extract from inputTokenCount/outputTokenCount format
        if (response.inputTokenCount !== undefined && response.outputTokenCount !== undefined) {
          const inputTokens = response.inputTokenCount || 0;
          const outputTokens = response.outputTokenCount || 0;
          console.log(`[Base] Tokens detectados de tokenCount directo: input=${inputTokens}, output=${outputTokens}`);
          return { inputTokens, outputTokens, ...metadata };
        }
        
        // Try to extract from metadata.usage
        if (response.metadata && response.metadata.usage) {
          const inputTokens = response.metadata.usage.prompt_tokens ??
                             response.metadata.usage.input_tokens ?? response.metadata.usage.promptTokens ?? 0;
          const outputTokens = response.metadata.usage.completion_tokens ??
                              response.metadata.usage.output_tokens ?? response.metadata.usage.completionTokens ?? 0;
          console.log(`[Base] Tokens detectados de metadata.usage: input=${inputTokens}, output=${outputTokens}`);
          return { inputTokens, outputTokens, ...metadata };
        }
        
        // If content is an object with token usage
        if (response.content && typeof response.content === 'object' && response.content.usage) {
          const inputTokens = response.content.usage.prompt_tokens ??
                             response.content.usage.input_tokens ?? response.content.usage.promptTokens ?? 0;
          const outputTokens = response.content.usage.completion_tokens ??
                              response.content.usage.output_tokens ?? response.content.usage.completionTokens ?? 0;
          console.log(`[Base] Tokens detectados de content.usage: input=${inputTokens}, output=${outputTokens}`);
          return { inputTokens, outputTokens, ...metadata };
        }
      }
      
      console.log(`[Base] No se detectaron tokens en la respuesta`);
      return { inputTokens: 0, outputTokens: 0, ...metadata };
    } catch (e) {
      console.error('[Base] Error extracting token usage:', e);
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