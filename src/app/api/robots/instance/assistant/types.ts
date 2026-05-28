export interface AssistantContext {
  instance: any;
  systemPrompt: string;
  customTools: any[];
  agentType?: string;
  userPhone?: string;
  executionOptions: {
    use_sdk_tools: boolean;
    /** Logging/credits label (NOT the underlying LLM provider). */
    provider: 'azure' | 'openai' | 'gemini';
    instance_id: string;
    site_id: string;
    user_id: string;
    /** Optional LLM provider override (gemini | azure | openai). Defaults to env AI_PROVIDER. */
    ai_provider?: 'gemini' | 'azure' | 'openai';
    /** Optional LLM model override. Defaults to env AI_MODEL / provider default. */
    ai_model?: string;
  };
  initialMessage: string;
  imageAssets: { url: string; fileType: string }[];
  hasLinkedRequirement: boolean;
  instanceNodeId?: string;
  expectedResultsAmount: number;
}
