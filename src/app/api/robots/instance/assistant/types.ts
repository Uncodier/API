import type { UiMediaOutputType } from './ui-media-contract';
import type { WorkflowToolExecutionTracker } from '@/lib/services/workflow-robot/execution-tracker';
import type { AssistantSkillSelection } from './skill-selection';
import type { AssistantRecoveryScope } from '@/lib/services/robot-instance/assistant-recovery';

export interface AssistantContext {
  instance: any;
  systemPrompt: string;
  customTools: any[];
  agentType?: string;
  userPhone?: string;
  executionOptions: {
    use_sdk_tools: boolean;
    /** Logging/credits label (NOT the underlying LLM provider). */
    provider: 'openrouter' | 'azure' | 'openai' | 'gemini';
    instance_id: string;
    site_id: string;
    user_id: string;
    requirement_id?: string;
    plan_id?: string;
    step_id?: string;
    /** Legacy labels are model-family hints; inference always uses OpenRouter. */
    ai_provider?: 'openrouter' | 'gemini' | 'azure' | 'openai';
    /** OpenRouter model ID, pinned to the history budget model during preparation. */
    ai_model?: string;
    // Inherited baseline time to determine if a sandbox file was modified this cycle.
    cycle_baseline_at?: string;
  };
  initialMessage: string;
  imageAssets: { url: string; fileType: string; publicUrl?: string }[];
  hasLinkedRequirement: boolean;
  instanceNodeId?: string;
  expectedResultsAmount: number;
  toolOverrides?: Record<string, any>;
  uiMediaOutputType?: UiMediaOutputType;
  toolExecutionTracker?: WorkflowToolExecutionTracker;
  /** Only expose plan_result while building a channel pre-response. */
  preResponseOnly?: boolean;
  selectedSkills?: AssistantSkillSelection;
  approvedImport?: { url: string; sha256: string; userId: string };
  recoveryScope?: AssistantRecoveryScope;
  /** Derived only from the claimed snapshot, not request/model arguments. */
  conversationRecoveryOnly?: boolean;
  nodeContinuation?: { responseNodeIds: string[] };
}
