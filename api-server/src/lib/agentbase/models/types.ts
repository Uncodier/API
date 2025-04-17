/**
 * Agentbase Core Types
 */

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
  model_type?: 'anthropic' | 'openai' | 'gemini';
  model_id?: string;
  max_tokens?: number;
  temperature?: number;
  response_format?: 'json' | 'text';
  system_prompt?: string;
  agent_id?: string;
  agent_background?: string;
  user_id: string;
  priority?: number;
  execution_order?: string[];
  supervision_params?: SupervisionParams;
  requires_capabilities?: string[];
  input_tokens?: number;
  output_tokens?: number;
  site_id?: string;
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
  model_type?: 'anthropic' | 'openai' | 'gemini';
  model_id?: string;
  max_tokens?: number;
  temperature?: number;
  response_format?: 'json' | 'text';
  system_prompt?: string;
  agent_id?: string;
  agent_background?: string;
  user_id: string;
  priority?: number;
  execution_order?: string[];
  supervision_params?: SupervisionParams;
  created_at: string;
  updated_at: string;
  duration?: number;
  results?: any[];
  requires_capabilities?: string[];
  input_tokens?: number;
  output_tokens?: number;
  site_id?: string;
  metadata?: {
    dbUuid?: string;
    createTime?: string;
    lastUpdated?: string;
    [key: string]: any;
  };
  error?: string;
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

// Portkey Model Options
export interface PortkeyModelOptions {
  modelType: 'anthropic' | 'openai' | 'gemini';
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
}

export interface AzureOpenAIOptions {
  endpoint: string;
  deploymentName?: string;
  apiVersion?: string;
}

export interface PortkeyConfig {
  apiKey: string;
  virtualKeys: Record<string, string>;
  baseURL?: string;
  useAzure?: boolean;
  azureOptions?: AzureOpenAIOptions;
} 