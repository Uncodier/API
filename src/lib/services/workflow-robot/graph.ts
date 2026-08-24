import type { WorkflowGraphNode, WorkflowStepSettings } from './types';
import { resolveMaxRetries } from './retry';

function promptText(node: WorkflowGraphNode): string {
  const p = node.prompt;
  if (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') {
    return (p as { text: string }).text;
  }
  return '';
}

function stepSettings(node: WorkflowGraphNode): WorkflowStepSettings {
  const raw = (node.settings?.step || node.settings || {}) as WorkflowStepSettings;
  return raw || {};
}

function topoSort(nodes: WorkflowGraphNode[]): WorkflowGraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const remaining = nodes.map((n) => n.id);
  const out: WorkflowGraphNode[] = [];

  const ready = () =>
    remaining.filter((id) => {
      const n = byId.get(id)!;
      return !n.parent_node_id || !remaining.includes(n.parent_node_id);
    });

  while (remaining.length > 0) {
    const batch = ready();
    if (batch.length === 0) {
      for (const id of remaining) out.push(byId.get(id)!);
      break;
    }
    batch.sort((a, b) => {
      const na = byId.get(a)!;
      const nb = byId.get(b)!;
      const oa = Number((na.settings as { order?: number })?.order ?? 0);
      const ob = Number((nb.settings as { order?: number })?.order ?? 0);
      return oa - ob || a.localeCompare(b);
    });
    for (const id of batch) {
      out.push(byId.get(id)!);
      const idx = remaining.indexOf(id);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }
  return out;
}

export function buildRunSteps(nodes: WorkflowGraphNode[]) {
  const executable = nodes.filter((n) => n.type === 'wf-step' || n.type === 'wf-condition');
  const ordered = topoSort(executable);
  return ordered.map((node, index) => {
    const settings = stepSettings(node);
    const title = (node.settings?.title as string) || promptText(node).slice(0, 80) || `Workflow ${node.type}`;
    return {
      id: `step_${index + 1}`,
      title,
      description: title,
      order: index + 1,
      status: 'pending',
      type: node.type === 'wf-condition' ? 'condition' : 'task',
      instructions: promptText(node) || title,
      expected_output: settings.expected_output || '',
      success_criteria: settings.success_criteria || [],
      validation_rules: settings.validation_rules || [],
      actual_output: null,
      started_at: null,
      completed_at: null,
      retry_count: 0,
      max_retries: resolveMaxRetries(settings.max_retries),
      recovery_plan: typeof settings.recovery_plan === 'string' ? settings.recovery_plan : '',
      error_message: null,
      artifacts: [],
      skill: settings.skill || 'makinari-rol-workflow-step',
      requires_sandbox: Boolean(settings.requires_sandbox),
      metadata: {
        node_id: node.id,
        requires_sandbox: Boolean(settings.requires_sandbox),
        mcp_actions: settings.mcp_actions || [],
        workflow_step: true,
      },
    };
  });
}
