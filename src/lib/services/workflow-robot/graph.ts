import type { WorkflowGraphNode, WorkflowStepSettings } from './types';
import { resolveMaxRetries } from './retry';
import { relationContext } from './relation-routing';

/** Keep only the selected trigger's descendants; never run sibling branches. */
export function channelTriggerBranch(nodes: WorkflowGraphNode[], triggerNodeId: string): WorkflowGraphNode[] {
  const triggers = nodes.filter((node) => node.type === 'wf-trigger');
  if (!triggers.some((node) => node.id === triggerNodeId)) return [];
  const ids = new Set([triggerNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parent_node_id && ids.has(node.parent_node_id) && !ids.has(node.id)) {
        ids.add(node.id);
        changed = true;
      }
    }
  }
  return nodes.filter((node) => ids.has(node.id));
}

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
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return ordered.map((node, index) => {
    const settings = stepSettings(node);
    const title = (node.settings?.title as string) || promptText(node).slice(0, 80) || `Workflow ${node.type}`;
    const hasBrowserInteractionFlag =
      typeof settings.browser_interaction_required === 'boolean';
    const requiresBrowserInteraction =
      settings.browser_interaction_required === true;
    const hasBrowserFlag =
      typeof settings.requires_browser === 'boolean' ||
      requiresBrowserInteraction;
    const requiresBrowser =
      settings.requires_browser === true ||
      requiresBrowserInteraction;
    const requiresSandbox = Boolean(settings.requires_sandbox || requiresBrowser);
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
      result: null,
      started_at: null,
      completed_at: null,
      retry_count: 0,
      max_retries: resolveMaxRetries(settings.max_retries),
      recovery_plan: typeof settings.recovery_plan === 'string' ? settings.recovery_plan : '',
      error_message: null,
      artifacts: [],
      skill: settings.skill || 'makinari-rol-workflow-step',
      requires_sandbox: requiresSandbox,
      ...(hasBrowserFlag ? { requires_browser: requiresBrowser } : {}),
      ...(hasBrowserInteractionFlag
        ? { browser_interaction_required: settings.browser_interaction_required }
        : {}),
      browser_allowed_domains: settings.browser_allowed_domains || [],
      browser_secret_names: settings.browser_secret_names || [],
      metadata: {
        node_id: node.id,
        ...(node.parent_node_id && byId.has(node.parent_node_id)
          ? { parent_node_id: node.parent_node_id, parent_type: byId.get(node.parent_node_id)?.type,
              relation_context: relationContext(node.settings?.relation_context) }
          : {}),
        requires_sandbox: requiresSandbox,
        ...(hasBrowserFlag ? { requires_browser: requiresBrowser } : {}),
        ...(hasBrowserInteractionFlag
          ? { browser_interaction_required: settings.browser_interaction_required }
          : {}),
        browser_allowed_domains: settings.browser_allowed_domains || [],
        browser_secret_names: settings.browser_secret_names || [],
        mcp_actions: settings.mcp_actions || [],
        workflow_step: true,
      },
    };
  });
}
