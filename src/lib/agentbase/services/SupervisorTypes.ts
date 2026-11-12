export interface SupervisorAnalysis {
  analysis: {
    summary: string;
    tools_available_count: number;
    tools_executed_count: number;
    errors_detected: Array<{
      type: string;
      description: string;
      severity: 'high' | 'medium' | 'low';
    }>;
  };
  errata: Array<{
    message: string;
  }>;
  system_suggested_tools_for_development: Array<{
    tool_name: string;
    description: string;
    use_case: string;
    priority: 'high' | 'medium' | 'low';
    rationale: string;
  }>;
  prompt_suggestions: Array<{
    context: string;
    improved_prompt: string;
    rationale: string;
    example: string;
  }>;
}

export interface SupervisorResult {
  success: boolean;
  analysis?: SupervisorAnalysis;
  error?: string;
  errata_applied?: number;
  emails_sent?: number;
  analyzed_command_id?: string; // The command that was analyzed (input)
  command_id?: string; // The supervisor command created for this analysis
}
