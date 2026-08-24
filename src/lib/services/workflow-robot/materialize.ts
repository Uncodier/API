import { supabaseAdmin } from '@/lib/database/supabase-client';
import type {
  MaterializeRunInput,
  MaterializeRunResult,
  WorkflowGraphNode,
  WorkflowTriggerConfig,
} from './types';
import { WF_NODE_TYPES } from './types';
import { buildRunSteps } from './graph';

export { buildRunSteps };

async function loadGraph(instanceId: string): Promise<WorkflowGraphNode[]> {
  const { data, error } = await supabaseAdmin
    .from('instance_nodes')
    .select('id, instance_id, parent_node_id, type, status, prompt, settings, site_id, user_id')
    .eq('instance_id', instanceId)
    .in('type', [...WF_NODE_TYPES]);

  if (error) throw new Error(`Failed to load workflow graph: ${error.message}`);
  return (data || []) as WorkflowGraphNode[];
}

async function upsertTemplatePlan(params: {
  instance_id: string;
  site_id: string;
  user_id?: string;
  steps: unknown[];
  title: string;
}): Promise<{ id: string; metadata: Record<string, unknown> }> {
  const { data: existing } = await supabaseAdmin
    .from('instance_plans')
    .select('id, metadata')
    .eq('instance_id', params.instance_id)
    .contains('metadata', { workflow_template: true })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const payload = {
    title: params.title,
    description: 'Workflow definition (not executed directly)',
    plan_type: 'task',
    status: 'blocked',
    site_id: params.site_id,
    user_id: params.user_id,
    instance_id: params.instance_id,
    steps: params.steps,
    steps_total: (params.steps as unknown[]).length,
    steps_completed: 0,
    progress_percentage: 0,
    metadata: {
      ...(existing?.metadata || {}),
      workflow_template: true,
    },
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { data, error } = await supabaseAdmin
      .from('instance_plans')
      .update(payload)
      .eq('id', existing.id)
      .select('id, metadata')
      .single();
    if (error) throw new Error(`Failed to update workflow template: ${error.message}`);
    return data as { id: string; metadata: Record<string, unknown> };
  }

  const { data, error } = await supabaseAdmin
    .from('instance_plans')
    .insert(payload)
    .select('id, metadata')
    .single();
  if (error) throw new Error(`Failed to create workflow template: ${error.message}`);
  return data as { id: string; metadata: Record<string, unknown> };
}

export async function syncWorkflowTriggersFromGraph(params: {
  instance_id: string;
  site_id: string;
  user_id?: string;
  template_plan_id: string;
  nodes: WorkflowGraphNode[];
}): Promise<void> {
  const triggers = params.nodes.filter((n) => n.type === 'wf-trigger');
  const { data: existing } = await supabaseAdmin
    .from('workflow_triggers')
    .select('id, node_id')
    .eq('instance_id', params.instance_id);

  const byNode = new Map((existing || []).map((r) => [r.node_id, r.id]));
  const keep = new Set<string>();

  for (const node of triggers) {
    const cfg = ((node.settings?.trigger || node.settings || {}) as WorkflowTriggerConfig);
    const kind = cfg.kind || 'manual';
    const row = {
      instance_id: params.instance_id,
      template_plan_id: params.template_plan_id,
      node_id: node.id,
      kind,
      config: cfg,
      enabled: Boolean(node.settings?.enabled ?? cfg.kind !== 'manual'),
      site_id: params.site_id,
      user_id: params.user_id,
      updated_at: new Date().toISOString(),
    };
    const existingId = byNode.get(node.id);
    if (existingId) {
      await supabaseAdmin.from('workflow_triggers').update(row).eq('id', existingId);
      keep.add(existingId);
    } else {
      const { data } = await supabaseAdmin.from('workflow_triggers').insert(row).select('id').single();
      if (data?.id) keep.add(data.id);
    }
  }

  const stale = (existing || []).filter((r) => r.id && !keep.has(r.id)).map((r) => r.id);
  if (stale.length) {
    await supabaseAdmin.from('workflow_triggers').delete().in('id', stale);
  }
}

export async function syncWorkflowDefinition(instanceId: string): Promise<{
  template_plan_id: string;
  trigger_count: number;
  has_sandbox_step: boolean;
}> {
  const { data: instance, error: instErr } = await supabaseAdmin
    .from('remote_instances')
    .select('id, site_id, user_id, name')
    .eq('id', instanceId)
    .single();
  if (instErr || !instance) throw new Error('Instance not found');

  const nodes = await loadGraph(instanceId);
  const steps = buildRunSteps(nodes);
  const title = `Workflow: ${instance.name || instanceId.slice(0, 8)}`;
  const template = await upsertTemplatePlan({
    instance_id: instanceId,
    site_id: instance.site_id,
    user_id: instance.user_id,
    steps,
    title,
  });
  await syncWorkflowTriggersFromGraph({
    instance_id: instanceId,
    site_id: instance.site_id,
    user_id: instance.user_id,
    template_plan_id: template.id,
    nodes,
  });
  return {
    template_plan_id: template.id,
    trigger_count: nodes.filter((n) => n.type === 'wf-trigger').length,
    has_sandbox_step: steps.some((s) => s.requires_sandbox),
  };
}

export async function materializeRunFromGraph(
  input: MaterializeRunInput,
): Promise<MaterializeRunResult> {
  if (input.idempotency_key) {
    const { data: dup } = await supabaseAdmin
      .from('workflow_runs')
      .select('id, run_plan_id, template_plan_id, dry_run')
      .eq('idempotency_key', input.idempotency_key)
      .maybeSingle();
    if (dup) {
      return {
        template_plan_id: dup.template_plan_id,
        run_plan_id: dup.run_plan_id,
        workflow_run_id: dup.id,
        dry_run: dup.dry_run,
        steps: [],
      };
    }
  }

  const { data: instance, error: instErr } = await supabaseAdmin
    .from('remote_instances')
    .select('id, site_id, user_id, name')
    .eq('id', input.instance_id)
    .single();
  if (instErr || !instance) throw new Error('Instance not found');

  const nodes = await loadGraph(input.instance_id);
  const steps = buildRunSteps(nodes);
  if (steps.length === 0) {
    throw new Error('Workflow graph has no steps. Add a wf-step node first.');
  }

  const title = `Workflow: ${instance.name || input.instance_id.slice(0, 8)}`;
  const template = await upsertTemplatePlan({
    instance_id: input.instance_id,
    site_id: instance.site_id,
    user_id: instance.user_id,
    steps,
    title,
  });

  await syncWorkflowTriggersFromGraph({
    instance_id: input.instance_id,
    site_id: instance.site_id,
    user_id: instance.user_id,
    template_plan_id: template.id,
    nodes,
  });

  const resetSteps = steps.map((s) => ({
    ...s,
    status: s.id === input.from_step_id || !input.from_step_id ? s.status : s.status,
  }));

  const { data: runPlan, error: runErr } = await supabaseAdmin
    .from('instance_plans')
    .insert({
      instance_id: input.instance_id,
      site_id: instance.site_id,
      user_id: instance.user_id,
      title: input.dry_run ? `${title} (test)` : title,
      description: 'Workflow run',
      plan_type: 'task',
      status: 'pending',
      parent_plan_id: template.id,
      steps: resetSteps,
      steps_total: resetSteps.length,
      steps_completed: 0,
      progress_percentage: 0,
      metadata: {
        workflow_run: true,
        dry_run: Boolean(input.dry_run),
        trigger_payload: input.trigger_payload || {},
      },
    })
    .select('id')
    .single();

  if (runErr || !runPlan) throw new Error(`Failed to create run plan: ${runErr?.message}`);

  const { data: wfRun, error: wfErr } = await supabaseAdmin
    .from('workflow_runs')
    .insert({
      instance_id: input.instance_id,
      template_plan_id: template.id,
      run_plan_id: runPlan.id,
      trigger_id: input.trigger_id || null,
      payload: input.trigger_payload || {},
      status: 'pending',
      dry_run: Boolean(input.dry_run),
      idempotency_key: input.idempotency_key || null,
      site_id: instance.site_id,
      user_id: instance.user_id,
    })
    .select('id')
    .single();

  if (wfErr || !wfRun) throw new Error(`Failed to create workflow run: ${wfErr?.message}`);

  return {
    template_plan_id: template.id,
    run_plan_id: runPlan.id,
    workflow_run_id: wfRun.id,
    dry_run: Boolean(input.dry_run),
    steps: resetSteps,
  };
}
