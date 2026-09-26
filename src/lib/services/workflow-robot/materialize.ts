import { supabaseAdmin } from '@/lib/database/supabase-client';
import type {
  MaterializeRunInput,
  MaterializeRunResult,
  WorkflowGraphNode,
  WorkflowTriggerConfig,
} from './types';
import { WF_NODE_TYPES } from './types';
import { buildRunSteps, channelTriggerBranch } from './graph';

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
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from('workflow_triggers')
    .select('id, node_id, kind')
    .eq('instance_id', params.instance_id);
  if (lookupError) throw new Error(`Failed to load workflow triggers: ${lookupError.message}`);

  const byNode = new Map((existing || []).map((r) => [`${r.node_id}:${r.kind}`, r.id]));
  const keep = new Set<string>();

  for (const node of triggers) {
    const cfg = ((node.settings?.trigger || node.settings || {}) as WorkflowTriggerConfig & { active_kinds?: string[] });
    const activeKindsArray = cfg.active_kinds || (cfg.kind ? [cfg.kind] : ['manual']);
    const activeKinds = Array.from(new Set(activeKindsArray));
    const channelSteps = buildRunSteps(channelTriggerBranch(params.nodes, node.id));
    const channelBranchSafe = channelSteps.length > 0 && channelSteps.every((step) =>
      !step.requires_sandbox && !step.requires_browser && !step.browser_interaction_required);

    for (const kind of activeKinds) {
      const row = {
        instance_id: params.instance_id,
        template_plan_id: params.template_plan_id,
        node_id: node.id,
        kind,
        config: cfg,
        enabled: Boolean(node.settings?.enabled ?? kind !== 'manual')
          && (kind !== 'channel_message' || channelBranchSafe),
        site_id: params.site_id,
        user_id: params.user_id,
        updated_at: new Date().toISOString(),
      };
      const existingId = byNode.get(`${node.id}:${kind}`);
      if (existingId) {
        const { error } = await supabaseAdmin.from('workflow_triggers').update(row).eq('id', existingId);
        if (error) throw new Error(`Failed to update workflow trigger: ${error.message}`);
        keep.add(existingId);
      } else {
        const { data, error } = await supabaseAdmin.from('workflow_triggers').insert(row).select('id').single();
        if (error || !data?.id) throw new Error(`Failed to insert workflow trigger: ${error?.message || 'missing ID'}`);
        keep.add(data.id);
      }
    }
  }

  const stale = (existing || []).filter((r) => r.id && !keep.has(r.id)).map((r) => r.id);
  if (stale.length) {
    const { error } = await supabaseAdmin.from('workflow_triggers').delete().in('id', stale);
    if (error) throw new Error(`Failed to remove stale workflow triggers: ${error.message}`);
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
  const preResponseOnly = input.pre_response_only === true;
  const dryRun = Boolean(input.dry_run);
  if (input.idempotency_key) {
    const { data: dup } = await supabaseAdmin
      .from('workflow_runs')
      .select('id, run_plan_id, template_plan_id, dry_run, status, claim_expires_at')
      .eq('idempotency_key', input.idempotency_key)
      .maybeSingle();
    if (dup) {
      return {
        template_plan_id: dup.template_plan_id,
        run_plan_id: dup.run_plan_id,
        workflow_run_id: dup.id,
        dry_run: dup.dry_run,
        steps: [],
        resume_existing_run:
          dup.status === 'pending' ||
          (
            dup.status === 'in_progress' &&
            typeof dup.claim_expires_at === 'string' &&
            Date.parse(dup.claim_expires_at) <= Date.now()
          ),
      };
    }
  }

  const { data: instance, error: instErr } = await supabaseAdmin
    .from('remote_instances')
    .select('id, site_id, user_id, name')
    .eq('id', input.instance_id)
    .single();
  if (instErr || !instance) throw new Error('Instance not found');

  let nodes = await loadGraph(input.instance_id);
  let preResponseTrigger: { template_plan_id: string | null; node_id: string | null } | null = null;
  if (preResponseOnly) {
    if (!input.trigger_id) throw new Error('Pre-response run requires a trigger');
    let triggerQuery = supabaseAdmin.from('workflow_triggers')
      .select('template_plan_id, node_id').eq('id', input.trigger_id)
      .eq('site_id', instance.site_id).eq('instance_id', input.instance_id)
      .eq('kind', 'channel_message');
    if (!input.dry_run) triggerQuery = triggerQuery.eq('enabled', true);
    const { data: trigger } = await triggerQuery.single();
    if (!trigger?.template_plan_id) throw new Error('Channel trigger has no template');
    preResponseTrigger = trigger;
    if (nodes.length && trigger.node_id) nodes = channelTriggerBranch(nodes, trigger.node_id);
    else if (nodes.length) throw new Error('Channel trigger has no graph node');
    if (!nodes.length || !nodes.some((node) => node.type === 'wf-step' || node.type === 'wf-condition')) {
      throw new Error('Channel trigger branch has no executable steps');
    }
  }
  let steps: any[] = [];
  let templateId: string;
  let title = `Workflow: ${instance.name || input.instance_id.slice(0, 8)}`;

  // If no visual graph nodes exist, check if there's an agent-created template
  if (nodes.length === 0) {
    let agentTemplate = null;
    
    if (input.trigger_id) {
      // Look up template by trigger_id if provided
      const { data: triggerData } = await supabaseAdmin
        .from('workflow_triggers')
        .select('template_plan_id')
        .eq('id', input.trigger_id)
        .single();
        
      if (triggerData?.template_plan_id) {
        const { data: tmpl } = await supabaseAdmin
          .from('instance_plans')
          .select('id, steps, title')
          .eq('id', triggerData.template_plan_id)
          .single();
        if (tmpl) agentTemplate = tmpl;
      }
    } else {
      // Fallback: get the most recent template for this instance
      const { data: latestTmpl } = await supabaseAdmin
        .from('instance_plans')
        .select('id, steps, title')
        .eq('instance_id', input.instance_id)
        .contains('metadata', { workflow_template: true })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestTmpl) agentTemplate = latestTmpl;
    }

    if (agentTemplate && Array.isArray(agentTemplate.steps) && agentTemplate.steps.length > 0) {
      steps = agentTemplate.steps;
      templateId = agentTemplate.id;
      title = agentTemplate.title || title;
    } else {
      throw new Error('Workflow graph has no steps and no agent-created template found. Add a wf-step node or use instance_plan tool first.');
    }
  } else {
    // We have visual nodes, use them
    steps = buildRunSteps(nodes);
    if (steps.length === 0) {
      throw new Error('Workflow graph has no executable steps.');
    }
    
    if (preResponseOnly && preResponseTrigger) {
      // Pre-response runs must not rewrite/sync trigger definitions on inbound traffic.
      templateId = preResponseTrigger.template_plan_id!;
    } else {
      const template = await upsertTemplatePlan({
        instance_id: input.instance_id,
        site_id: instance.site_id,
        user_id: instance.user_id,
        steps,
        title,
      });
      templateId = template.id;

      await syncWorkflowTriggersFromGraph({
        instance_id: input.instance_id,
        site_id: instance.site_id,
        user_id: instance.user_id,
        template_plan_id: templateId,
        nodes,
      });
    }
  }

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
      title: preResponseOnly ? `${title} (pre-response)` : input.dry_run ? `${title} (test)` : title,
      description: 'Workflow run',
      plan_type: 'task',
      status: 'pending',
      parent_plan_id: templateId,
      steps: resetSteps,
      steps_total: resetSteps.length,
      steps_completed: 0,
      progress_percentage: 0,
      metadata: {
        workflow_run: true,
        dry_run: dryRun,
        trigger_payload: input.trigger_payload || {},
        ...(preResponseOnly ? { pre_response_only: true } : {}),
      },
    })
    .select('id')
    .single();

  if (runErr || !runPlan) throw new Error(`Failed to create run plan: ${runErr?.message}`);

  const { data: wfRun, error: wfErr } = await supabaseAdmin
    .from('workflow_runs')
    .insert({
      instance_id: input.instance_id,
      template_plan_id: templateId,
      run_plan_id: runPlan.id,
      trigger_id: input.trigger_id || null,
      payload: input.trigger_payload || {},
      status: 'pending',
      dry_run: dryRun,
      idempotency_key: input.idempotency_key || null,
      site_id: instance.site_id,
      user_id: instance.user_id,
    })
    .select('id')
    .single();

  if (wfErr || !wfRun) {
    if (wfErr?.code === '23505' && input.idempotency_key) {
      // The unique (site_id, idempotency_key) index resolves concurrent deliveries.
      // The losing plan must never be executed or left pending for a scheduler.
      const { error: cleanupError } = await supabaseAdmin.from('instance_plans').delete().eq('id', runPlan.id);
      if (cleanupError) console.error('[WorkflowMaterialize] Failed to remove duplicate plan:', cleanupError);
      const { data: existing, error: lookupError } = await supabaseAdmin
        .from('workflow_runs')
        .select('id, run_plan_id, template_plan_id, dry_run, status, claim_expires_at')
        .eq('site_id', instance.site_id)
        .eq('idempotency_key', input.idempotency_key)
        .maybeSingle();
      if (!lookupError && existing) {
        return {
          template_plan_id: existing.template_plan_id,
          run_plan_id: existing.run_plan_id,
          workflow_run_id: existing.id,
          dry_run: existing.dry_run,
          steps: [],
          resume_existing_run: existing.status === 'pending' || (
            existing.status === 'in_progress' &&
            typeof existing.claim_expires_at === 'string' &&
            Date.parse(existing.claim_expires_at) <= Date.now()
          ),
        };
      }
    }
    throw new Error(`Failed to create workflow run: ${wfErr?.message}`);
  }

  return {
    template_plan_id: templateId,
    run_plan_id: runPlan.id,
    workflow_run_id: wfRun.id,
    dry_run: dryRun,
    steps: resetSteps,
  };
}
