import type { GateFailureCategory } from '@/app/api/cron/shared/step-iteration-signals';

export type FailureClass = 'product' | 'plumbing' | 'judge';

export interface ClassifiedFailure {
  failureClass: FailureClass;
  toolName?: string;
  category?: GateFailureCategory;
  countsTowardAttempts: boolean;
}

/**
 * Classifies an error string to determine if it is a product verification failure (which should 
 * consume budget/attempts) or a plumbing failure (which should not).
 * 
 * @param errorText The error message returned by a tool or gate
 * @param categories Optional categories from the gate signals
 */
export function classifyFailure(errorText: string, categories?: GateFailureCategory[]): ClassifiedFailure {
  const error = errorText.toLowerCase();

  // 1. Judge verdicts
  if (error.includes('judge_verdict')) {
    return {
      failureClass: 'judge',
      countsTowardAttempts: true,
    };
  }

  // 2. Gate failures -> Check if it's a known product category
  // If categories array is provided and not empty, it's a product gate failure
  if (categories && categories.length > 0) {
    return {
      failureClass: 'product',
      category: categories[0],
      countsTowardAttempts: true,
    };
  }

  // Fallback heuristic based on text if categories aren't explicitly passed
  if (error.includes('gate_failed:') || error.includes('gate failed')) {
    if (
      error.includes('build') ||
      error.includes('runtime') ||
      error.includes('api') ||
      error.includes('console') ||
      error.includes('scenario') ||
      error.includes('visual') ||
      error.includes('origin') ||
      error.includes('deploy')
    ) {
      return {
        failureClass: 'product',
        countsTowardAttempts: true,
      };
    }
  }

  // 3. Plumbing failures (serialization, sandbox infra, credits, tool not found, etc.)
  let toolName = undefined;
  
  // Extract tool name if possible
  const toolNameMatch = errorText.match(/Tool ([\w_]+) failed/i) || 
                        errorText.match(/failed to call tool ([\w_]+)/i) ||
                        errorText.match(/in tool ([\w_]+)/i) ||
                        errorText.match(/tool_execution_failed.*?([\w_]+)/i);
                        
  if (toolNameMatch && toolNameMatch[1]) {
    toolName = toolNameMatch[1];
  } else if (error.includes('instance_plan')) {
    toolName = 'instance_plan';
  } else if (error.includes('sandbox')) {
    toolName = 'sandbox';
  }

  return {
    failureClass: 'plumbing',
    toolName,
    countsTowardAttempts: false,
  };
}
