type Step = {
  id?: string;
  order?: number;
  status?: string;
  metadata?: { node_id?: string; parent_node_id?: string; parent_type?: string; relation_context?: string };
};

export const DEFAULT_WORKFLOW_RELATION_CONTEXT = 'on success';

export function relationContext(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 120) : DEFAULT_WORKFLOW_RELATION_CONTEXT;
}

export function shouldRunWorkflowStep(step: Step, steps: Step[]): boolean {
  const parentId = step.metadata?.parent_node_id;
  if (!parentId) return true;
  const parent = steps.find((candidate) => candidate.metadata?.node_id === parentId);
  // Triggers are not executable plan steps. Legacy plans may also lack parent metadata.
  if (!parent) {
    const relation = relationContext(step.metadata?.relation_context).toLowerCase();
    return step.metadata?.parent_type !== 'wf-trigger' ||
      (relation !== 'on fail' && relation !== 'on error' && relation !== 'on failure');
  }

  const relation = relationContext(step.metadata?.relation_context).toLowerCase();
  if (parent.status === 'pending' || parent.status === 'in_progress') return false;
  if (parent.status === 'cancelled') return false;
  if (relation === 'always') return true;
  if (relation === 'on fail' || relation === 'on error' || relation === 'on failure') {
    return parent.status === 'failed';
  }
  if (relation === 'on success') return parent.status === 'completed';
  // Custom context is sent to the agent to evaluate against the parent's output.
  return parent.status === 'completed' || parent.status === 'failed';
}

export function workflowRelationPrompt(step: Step, steps: Step[]): string {
  const relation = relationContext(step.metadata?.relation_context);
  const parent = steps.find((candidate) => candidate.metadata?.node_id === step.metadata?.parent_node_id);
  return parent
    ? `Incoming relation: ${relation}. Parent step: ${parent.order ?? parent.id ?? parent.metadata?.node_id} (${parent.status || 'unknown'}). ` +
      'For a custom relation, assess its conditions against the trigger and previous step outputs before taking action. ' +
      'If the condition is not met, do not perform side effects; call plan_result with status="skipped", a factual reason, data={}, evidence=[], criteria=[], and validation=[].'
    : `Incoming relation: ${relation} (workflow trigger). ` +
      'For a custom relation, check its conditions against the trigger payload before taking action. ' +
      'If not met, do not perform side effects; call plan_result with status="skipped", a factual reason, data={}, evidence=[], criteria=[], and validation=[].';
}