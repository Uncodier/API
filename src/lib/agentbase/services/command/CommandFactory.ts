/**
 * Command Factory for creating standardized command objects
 */
import { CreateCommandParams, SupervisionParams } from '../../models/types';

export class CommandFactory {
  /**
   * Creates a new command with required fields
   */
  static createCommand(params: {
    task: string;
    userId: string;
    description?: string;
    targets?: any[];
    tools?: any[];
    context?: string;
    supervisor?: any[];
    agentId?: string;
    model?: string;
    modelType?: 'anthropic' | 'openai' | 'gemini';
    modelId?: string;
    maxTokens?: number;
    temperature?: number;
    responseFormat?: 'json' | 'text';
    systemPrompt?: string;
    priority?: number;
    executionOrder?: string[];
    supervisionParams?: SupervisionParams;
    requiresCapabilities?: string[];
    site_id?: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'minimal';
    verbosity?: 'low' | 'medium' | 'high';
    toolsModel?: string;
    toolsModelType?: 'anthropic' | 'openai' | 'gemini';
    toolsModelId?: string;
  }): CreateCommandParams {
    // Combine modelType and modelId into a single model field for database compatibility
    let modelField = params.model;
    if (params.modelType && params.modelId) {
      modelField = `${params.modelType}:${params.modelId}`;
    } else if (params.modelId) {
      modelField = params.modelId;
    }
    
    // Process tools model fields similar to main model
    let toolsModelField = params.toolsModel;
    if (params.toolsModelType && params.toolsModelId) {
      toolsModelField = `${params.toolsModelType}:${params.toolsModelId}`;
    } else if (params.toolsModelId) {
      toolsModelField = params.toolsModelId;
    }
    
    return {
      task: params.task,
      status: 'pending',
      description: params.description,
      targets: params.targets || [],
      tools: params.tools || [],
      context: params.context,
      supervisor: params.supervisor,
      model: modelField,
      model_type: params.modelType, // Keep for internal processing
      model_id: params.modelId, // Keep for internal processing
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      response_format: params.responseFormat,
      system_prompt: params.systemPrompt,
      agent_id: params.agentId,
      user_id: params.userId,
      priority: params.priority || 5,
      execution_order: params.executionOrder,
      supervision_params: params.supervisionParams,
      requires_capabilities: params.requiresCapabilities,
      site_id: params.site_id,
      reasoning_effort: params.reasoningEffort,
      tools_model: toolsModelField,
      tools_model_type: params.toolsModelType,
      tools_model_id: params.toolsModelId
    };
  }
  
  /**
   * Generate a unique command ID
   */
  static generateCommandId(): string {
    return `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
  
  /**
   * Create a tool definition
   */
  static createTool(params: {
    name: string;
    description: string;
    type: 'synchronous' | 'asynchronous';
    parameters?: Record<string, any>;
    executionIndex?: number;
    supervisionRequired?: boolean;
  }): any {
    return {
      name: params.name,
      description: params.description,
      status: 'not_initialized',
      type: params.type,
      parameters: params.parameters || {},
      execution_index: params.executionIndex,
      supervision_required: params.supervisionRequired || false
    };
  }
  
  /**
   * Common tools that can be reused across commands
   */
  static commonTools = {
    dataFetch: (params?: Record<string, any>) => CommandFactory.createTool({
      name: 'data_fetch',
      description: 'Fetch data from external sources',
      type: 'synchronous',
      parameters: params
    }),
    
    search: (params?: Record<string, any>) => CommandFactory.createTool({
      name: 'search',
      description: 'Search knowledge base for relevant information',
      type: 'synchronous',
      parameters: params
    }),
    
    textProcessing: (params?: Record<string, any>) => CommandFactory.createTool({
      name: 'text_processing',
      description: 'Process and transform text data',
      type: 'synchronous',
      parameters: params
    })
  };
} 