/**
 * Agentbase - Framework para construir agentes
 */

// Command API
export { CommandFactory } from './services/CommandFactory';

// Services
export { default as ProcessorInitializer } from './services/ProcessorInitializer';
export { CommandService } from './services/CommandService';
export { PortkeyConnector } from './services/PortkeyConnector';

// Agents / Processors
export { Base } from './agents/Base';
export { AgentConnector } from './agents/AgentConnector';
export { ToolEvaluator } from './agents/ToolEvaluator';
export { TargetProcessor } from './agents/TargetProcessor';

// Adapters
export { DatabaseAdapter } from './adapters/DatabaseAdapter';

// Types
export type { 
  DbCommand, 
  CommandExecutionResult, 
  ToolExecutionResult,
  PortkeyConfig,
  PortkeyModelOptions
} from './models/types';

// Export utilities
export function generateId(prefix: string = 'id'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function calculateDuration(startTime: string): number {
  const start = new Date(startTime).getTime();
  const end = new Date().getTime();
  return end - start;
}

export function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

// Export supervision utilities
export function createSupervisionParams(params: Partial<any>): any {
  return {
    autoApproveThreshold: params.autoApproveThreshold ?? 0.8,
    requireApprovalFor: params.requireApprovalFor || [],
    supervisorRoles: params.supervisorRoles || ['supervisor'],
    timeoutSeconds: params.timeoutSeconds ?? 300,
    escalationPath: params.escalationPath || []
  };
}

// Error handling utilities
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  backoffMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      console.error(`Attempt ${attempt} failed: ${error.message}`);
      
      if (attempt < maxRetries) {
        // Wait with exponential backoff
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError || new Error(`Failed after ${maxRetries} attempts`);
} 