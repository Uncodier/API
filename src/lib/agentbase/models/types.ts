/**
 * Agentbase Core Types
 */

export type AgentModelType = 'openrouter' | 'anthropic' | 'openai' | 'gemini';

// Command Status Types
export type CommandStatus = 'pending' | 'running' | 'completed' | 'failed' | 'pending_supervision';

// Command Types
export interface CreateCommandParams {
  task: string;
  status: CommandStatus;
  description?: string;
  targets?: any[];
  tools?: any[];
  context?: string;
  supervisor?: any[];
  model?: string;
  model_type?: AgentModelType;
  model_id?: string;
  max_tokens?: number;
  temperature?: number;
  response_format?: 'json' | 'text';
  system_prompt?: string;
  agent_id?: string;
  agent_role?: string;
  agent_background?: string;
  user_id: string;
  priority?: number;
  execution_order?: string[];
  supervision_params?: SupervisionParams;
  requires_capabilities?: string[];
  input_tokens?: number;
  output_tokens?: number;
  site_id?: string;
  metadata?: {
    dbUuid?: string;
    createTime?: string;
    lastUpdated?: string;
    agent_role?: string;
    [key: string]: any;
  };
  reasoning_effort?: 'low' | 'medium' | 'high' | 'minimal';
  tools_model?: string;
  tools_model_type?: AgentModelType;
  tools_model_id?: string;
}

export interface DbCommand {
  id: string;
  task: string;
  status: CommandStatus;
  description?: string;
  targets?: any[];
  tools?: any[];
  context?: string;
  supervisor?: any[];
  model?: string;
  model_type?: AgentModelType;
  model_id?: string;
  max_tokens?: number;
  temperature?: number;
  response_format?: 'json' | 'text';
  system_prompt?: string;
  agent_id?: string;
  agent_role?: string;
  agent_background?: string;
  user_id: string;
  priority?: number;
  execution_order?: string[];
  supervision_params?: SupervisionParams;
  created_at: string;
  updated_at: string;
  duration?: number;
  results?: any[];
  functions?: any[];
  requires_capabilities?: string[];
  input_tokens?: number;
  output_tokens?: number;
  site_id?: string;
  reasoning_effort?: 'low' | 'medium' | 'high' | 'minimal';
  tools_model?: string;
  tools_model_type?: AgentModelType;
  tools_model_id?: string;
  metadata?: {
    dbUuid?: string;
    createTime?: string;
    lastUpdated?: string;
    [key: string]: any;
  };
  error?: string;
  tool_execution_failed?: boolean;
  tool_execution_error?: string;
}

// Command Execution Result
export interface CommandExecutionResult {
  status: CommandStatus;
  error?: string;
  results?: any[];
  supervisionRequestId?: string;
  updatedCommand?: DbCommand;
  warning?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Provider accounting metadata, distinct from product credit pricing. */
  usage?: Record<string, unknown>;
  cost?: number;
  cost_details?: Record<string, unknown>;
  is_byok?: boolean;
  generationId?: string;
  provider?: string;
  model?: string;
}

// Tool Execution Result
export interface ToolExecutionResult {
  tool: string;
  status: 'completed' | 'failed';
  result?: any;
  error?: string;
}

// Supervision Types
export type SupervisionStatus = 'pending' | 'approved' | 'rejected' | 'modified';

export interface SupervisionRequest {
  commandId: string;
  results: any[];
  context: string;
  requestedBy: string;
  priority: number;
}

export interface SupervisionResponse {
  requestId: string;
  status: SupervisionStatus;
  commandId: string;
  reviewedAt?: string;
  reviewedBy?: string;
  comments?: string;
  modifications?: any[];
}

export interface SupervisionDecision {
  status: 'approved' | 'rejected' | 'modified';
  comments?: string;
  modifications?: any[];
}

export interface SupervisionParams {
  autoApproveThreshold?: number;
  requireApprovalFor?: string[];
  supervisorRoles: string[];
  timeoutSeconds?: number;
  escalationPath?: string[];
}

// Model vendor hints are independent from the OpenRouter transport.
export interface OpenRouterModelOptions {
  modelType: AgentModelType;
  modelId?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  responseFormat?: 'json' | 'text';
  systemPrompt?: string;
  stream?: boolean;
  streamOptions?: {
    includeUsage?: boolean;
  };
  reasoningEffort?: 'low' | 'medium' | 'high' | 'minimal';
  verbosity?: 'low' | 'medium' | 'high';
  siteId?: string;
}

export interface AzureOpenAIOptions {
  endpoint: string;
  deploymentName?: string;
  apiVersion?: string;
}

export interface OpenRouterConfig {
  apiKey?: string;
  timeout?: number;
  /** @deprecated Rejected. Remove legacy virtual keys before using OpenRouter. */
  virtualKeys?: Record<string, string>;
  /** @deprecated Ignored. */
  baseURL?: string;
  /** @deprecated Azure transport configuration is rejected by the connector. */
  useAzure?: boolean;
  azureOptions?: AzureOpenAIOptions;
}

/** @deprecated Use OpenRouterModelOptions / OpenRouterConfig. */
export type PortkeyModelOptions = OpenRouterModelOptions;
export type PortkeyConfig = OpenRouterConfig;