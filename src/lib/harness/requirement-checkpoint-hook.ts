import { checkpointRequirementWorkspace } from './requirement-checkpoint';
import type { RequirementCheckpointBaseline, RequirementCheckpointPublicationIntent } from './requirement-checkpoint';
import type { RequirementRun } from './requirement-types';
import type { HostProfile } from './profile';
import type { SessionRuntimeOptions } from '@/app/api/robots/instance/assistant/requirement-workspace';

interface CheckpointClient {
  from(table: string): any;
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/** Host-only lifecycle hook; never listed among model tools or driven by model arguments. */
export function requirementCheckpointHook(options: { run: RequirementRun; repositoryUrl: string;
  branch: string; baseRef?: string; profile: HostProfile; client: CheckpointClient }): NonNullable<SessionRuntimeOptions['checkpoint']> {
  const { run, repositoryUrl, branch, baseRef, profile, client } = options;
  return async ({ workspace, redact, assertActive, signal, owner }) => {
    await assertActive();
    const { data, error } = await client.from('requirement_source_checkpoints').select('baseline,pending_publication')
      .eq('requirement_id', run.requirementId).eq('site_id', run.siteId).maybeSingle();
    // Missing migration/storage is not permission to publish without conflict history.
    if (error) { console.warn('[Source checkpoint] Receipt storage unavailable; source backup was not attempted.'); return; }
    const result = await checkpointRequirementWorkspace({ run, workspace, repositoryUrl, branch, baseRef,
      git: profile.git, baseline: data?.baseline as RequirementCheckpointBaseline | undefined,
      pendingPublication: data?.pending_publication as RequirementCheckpointPublicationIntent | undefined,
      preparePublication: async intent => {
        await assertActive();
        const prepared = await client.rpc('prepare_requirement_source_checkpoint', {
          p_requirement_id: run.requirementId, p_run_id: run.runId, p_generation: run.executionGeneration,
          p_session_id: run.sessionId, p_owner: owner, p_intent: intent,
        });
        if (prepared.error || prepared.data !== true) throw new Error('Checkpoint publication intent unavailable');
        await assertActive();
      },
      redact, assertActive, signal });
    const { baseline, ...receipt } = result;
    await assertActive();
    const saved = await client.rpc('record_requirement_source_checkpoint', {
      p_requirement_id: run.requirementId, p_run_id: run.runId, p_generation: run.executionGeneration,
      p_session_id: run.sessionId, p_owner: owner, p_result: receipt, p_baseline: baseline ?? null,
    });
    if (saved.error || saved.data !== true) console.warn('[Source checkpoint] Receipt not saved; no task status was changed.');
  };
}