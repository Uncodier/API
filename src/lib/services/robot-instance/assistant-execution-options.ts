import type { AIProvider } from '@/lib/custom-automation/ai-agent-executor';

export interface AssistantExecutionOptions {
  use_sdk_tools?: boolean;
  provider?: AIProvider;
  system_prompt?: string;
  custom_tools?: any[];
  instance_id?: string;
  site_id?: string;
  user_id?: string;
  requirement_id?: string;
  instance_node_id?: string;
  expected_results_amount?: number;
  ai_provider?: AIProvider;
  ai_model?: string;
  plan_id?: string;
  step_id?: string;
  enforceSingleTurn?: boolean;
  tool_overrides?: Record<string, any>;
  /** The messages argument already contains the full node conversation. */
  node_continuation?: { responseNodeIds: string[] };
}

export interface AssistantExecutionResult {
  text: string;
  output: any;
  usage: any;
  steps?: any[];
}

export interface AssistantStepExecutionResult extends AssistantExecutionResult {
  messages: any[];
  isDone: boolean;
  continuation?: { responseNodeIds: string[] };
  executionStatus?: 'completed' | 'exhausted';
  resumable?: boolean;
}

/** Prepare the tools shared by bounded and legacy assistant execution. */
export async function prepareAssistantTools(
  _instance: any,
  options: AssistantExecutionOptions,
) {
  return { type: 'openrouter', tools: options.custom_tools || [] };
}