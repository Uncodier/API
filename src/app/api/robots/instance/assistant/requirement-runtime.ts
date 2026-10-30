import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createSession, sessionRequestSchema } from '@/lib/harness/session';
import { createSessionStore } from '@/lib/harness/store';
import { executeRequirementAssistantWorkspace } from './requirement-workspace';
import { resolveRequirementEnvironment } from '@/lib/services/requirement-environment';
import { runCloudRequirementCycle } from './requirement-cloud';
import { openWorkspace, adoptRequirementWorkspace, shellQuote } from '@/lib/harness/workspace';
import { assertRequirementRun, finishRequirementCycle } from '@/lib/harness/requirement-scheduler';
import { loadRequirementContext, formatRequirementContext, loadRequirementSnapshot, formatRequirementSnapshot } from '@/lib/harness/requirement-context';
import { createRequirementTools } from '@/lib/harness/requirement-tools';
import { buildRequirementProfile } from '@/lib/harness/requirement-profile';
import { createRequirementProvisioningTools } from '@/lib/harness/requirement-provisioning';
import { requirementCheckpointHook } from '@/lib/harness/requirement-checkpoint-hook';
import { createRedactor } from '@/lib/harness/security';
import type { RequirementRun } from '@/lib/harness/requirement-types';
import type { HarnessSession } from '@/lib/harness/types';
import { assertToolScreenAccess } from '@/app/api/agents/tools/router/screen-access';
import { writeRequirementInstanceLog } from './requirement-instance-log';
import { evaluateRequirementCycleBudget } from './requirement-budget';

function summary(session: HarnessSession | null): string {
  const finish = session?.status === 'completed' && session.messages.findLast(message => message.role === 'tool' && message.toolCallId &&
    session.messages.some(previous => previous.toolCalls?.some(call => call.id === message.toolCallId && call.name === 'finish_task')));
  if (finish) {
    try {
      const value = JSON.parse(finish.content).output?.summary;
      if (typeof value === 'string') return value.slice(0, 12000);
    } catch { /* receipt may be an artifact reference */ }
  }
  return session?.status !== 'running' && session?.reason || 'Agent cycle saved. Remaining work continues on the next cron tick.';
}

/** Cron lifecycle adapter. All model turns execute through instance/assistant. */
export async function runRequirementCycle(run: RequirementRun) {
  const store = createSessionStore();
  const assertActive = async () => {
    await assertRequirementRun(run);
    await assertToolScreenAccess('requirement_context', { siteId: run.siteId, userId: run.userId });
  };
  let outcome = 'waiting';
  let reason = 'runtime_unavailable';
  let repoUrl: string | undefined;
  try {
    await assertActive();
    if (await evaluateRequirementCycleBudget(run)) {
      return { reqId: run.requirementId, sessionId: run.sessionId, status: 'paused' };
    }
    // Routine admission belongs to runtime diagnostics, not the user timeline.
    console.info('[Requirement assistant] Cycle admitted.');
    const context = await loadRequirementContext(run);
    // Private configuration is loaded separately; the agent context deliberately omits raw metadata.
    const { data: privateRequirement, error: privateError } = await supabaseAdmin.from('requirements').select('metadata,type,cron')
      .eq('id', run.requirementId).eq('site_id', run.siteId).eq('user_id', run.userId).single();
    if (privateError || !privateRequirement) throw new Error('Requirement execution configuration unavailable');
    const hostContext = { ...context, requirement: { ...context.requirement, metadata: privateRequirement.metadata, type: privateRequirement.type } };
    if (resolveRequirementEnvironment(privateRequirement.metadata) === 'cloud') {
      const result = await runCloudRequirementCycle(run,
        [context.requirement.title, context.requirement.instructions, context.requirement.description].filter(Boolean).join('\n\n'),
        assertActive, async () => formatRequirementSnapshot(await loadRequirementSnapshot(run)));
      await finishRequirementCycle(run, result.status, result.session?.reason || '', summary(result.session));
      return { reqId: run.requirementId, sessionId: run.sessionId, status: result.status };
    }
    const configured = await buildRequirementProfile(run, hostContext);
    repoUrl = configured.repository.url.replace(/\.git$/, '') + `/tree/${configured.branch}`;
    let session = await store.load(run.sessionId, run.siteId);
    if (!session) {
      const initial = createSession(sessionRequestSchema.parse({
        objective: [context.requirement.title, context.requirement.instructions, context.requirement.description].filter(Boolean).join('\n\n').slice(0, 24000),
        repository: configured.repository,
        // Legacy snapshot fields are supplied by the schema for compatibility;
        // canonical execution uses credits and the per-cycle monetary budget check.
      }), run.sessionId);
      initial.request.requirementId = run.requirementId;
      await assertActive();
      await store.create(initial, { siteId: run.siteId, userId: run.userId });
      session = initial;
    }
    if (session.request.executionEnvironment === 'cloud' || session.request.requirementId !== run.requirementId || session.request.repository?.url !== configured.repository.url) {
      throw new Error('Requirement session binding changed');
    }
    const persistedRepository = session.request.repository!;
    // Prefer the saved VM, including uncommitted files, over cloning origin again.
    const { data: previous, error } = await supabaseAdmin.from('requirement_status').select('active_sandbox_id')
      .eq('requirement_id', run.requirementId).eq('site_id', run.siteId).eq('instance_id', run.instanceId)
      .not('active_sandbox_id', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error('Existing requirement workspace lookup unavailable');
    const existingWorkspace = session.workspace?.id || previous?.active_sandbox_id;
    const { data: mapping, error: mappingError } = await supabaseAdmin.from('harness_requirement_runs').select('previous_session_id')
      .eq('requirement_id', run.requirementId).eq('site_id', run.siteId).eq('session_id', run.sessionId).single();
    if (mappingError) throw new Error('Requirement occurrence binding unavailable');
    let previousSessionId: string | undefined;
    if (mapping?.previous_session_id) {
      const priorSession = await store.load(mapping.previous_session_id, run.siteId);
      if (priorSession?.request.requirementId === run.requirementId && ['completed', 'cancelled'].includes(priorSession.status)) {
        previousSessionId = priorSession.id;
      }
    }
    const outcomeResult = await executeRequirementAssistantWorkspace(run.sessionId, { siteId: run.siteId, userId: run.userId }, {
      profile: configured.profile, cronRun: run, assertExecution: assertActive,
      assertCleanup: () => assertRequirementRun(run, true),
      context: `${formatRequirementContext(context)}\nIntended work branch: ${configured.branch}. Preserve existing uncommitted changes and all user restrictions.`,
      getContext: async () => formatRequirementSnapshot(await loadRequirementSnapshot(run)),
      checkpoint: requirementCheckpointHook({ run, repositoryUrl: configured.repository.url,
        branch: configured.branch, baseRef: configured.repository.ref, profile: configured.profile, client: supabaseAdmin }),
      tools: async (workspace, host) => [...await createRequirementTools({ run }),
        ...createRequirementProvisioningTools({ run, profile: configured.profile, branch: configured.branch, host, workspace, assertActive })],
      openWorkspace: async input => {
        const workspace = existingWorkspace
          ? await adoptRequirementWorkspace({ ...input, repository: persistedRepository, workspaceId: existingWorkspace, previousSessionId, assertActive: input.assertActive! })
          : await openWorkspace(input);
        await assertActive();
        // Non-destructive branch switch only at initial clone. Adopted working trees
        // keep their branch/dirty content; agent receives the intended branch in context.
        if (!existingWorkspace) {
          const command = `if git show-ref --verify --quiet ${shellQuote(`refs/heads/${configured.branch}`)}; then git switch ${shellQuote(configured.branch)}; elif git show-ref --verify --quiet ${shellQuote(`refs/remotes/origin/${configured.branch}`)}; then git switch --track ${shellQuote(`origin/${configured.branch}`)}; else git switch -c ${shellQuote(configured.branch)}; fi`;
          const branch = await workspace.exec({ command, timeoutMs: 10000 }, input.signal);
          if (branch.exitCode !== 0) throw new Error('Could not select requirement work branch without overwriting work');
        }
        await assertActive();
        const { error: recordError } = await supabaseAdmin.from('requirement_status').insert({
          requirement_id: run.requirementId, site_id: run.siteId, instance_id: run.instanceId, stage: 'in-progress',
          message: 'Agent workspace attached; validation and provisioning are available as tools.',
          active_sandbox_id: workspace.ref.id, repo_url: repoUrl,
        });
        if (recordError) throw new Error('Workspace reference could not be saved');
        return workspace;
      },
    });
    outcome = outcomeResult.status;
    session = await store.load(run.sessionId, run.siteId);
    reason = session?.reason || '';
    if (reason.includes('billing_unavailable_or_exhausted') || reason.includes('provider_admission_requires_operator')) {
      outcome = 'paused'; reason = reason.includes('billing_unavailable_or_exhausted') ? 'billing_unavailable_or_exhausted' : 'provider_admission_requires_operator';
      await store.control(run.sessionId, run.siteId, 'pause');
    }
    await finishRequirementCycle(run, outcome, reason, summary(session), repoUrl);
    return { reqId: run.requirementId, sessionId: run.sessionId, status: outcome };
  } catch (error) {
    const detail = createRedactor()(error instanceof Error ? error.message : 'Execution unavailable').slice(0, 1000);
    await writeRequirementInstanceLog(run, { key: `admission-error:${run.runId}`, log_type: 'error',
      message: 'Requirement assistant could not complete this cycle.', is_error: true,
      details: { error: detail } }).catch(() => undefined);
    if (error instanceof Error && (error.name === 'RecoveryError' || error.name === 'OpenRouterBillingError')) {
      outcome = 'paused';
      reason = 'assistant_execution_requires_reconciliation';
    }
    await finishRequirementCycle(run, outcome, reason, detail, repoUrl).catch(() => undefined);
    return { reqId: run.requirementId, sessionId: run.sessionId, status: outcome };
  }
}