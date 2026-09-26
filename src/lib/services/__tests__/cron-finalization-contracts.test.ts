import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function workspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('atomic requirement finalization contracts', () => {
  const sql = workspaceFile(
    'supabase/migrations/20260917203900_atomic_requirement_finalization.sql',
  );
  const terminalStepSql = workspaceFile(
    'supabase/migrations/20260917204000_terminal_step_infrastructure_cleanup.sql',
  );
  const finalizerSource = workspaceFile(
    'src/app/api/cron/shared/cron-workflow-finalize.ts',
  );
  const singleTurnSource = workspaceFile(
    'src/app/api/cron/shared/single-turn-executor.ts',
  );
  const workflowSource = workspaceFile(
    'src/app/api/cron/requirements-apps/workflow.ts',
  );
  const commitWorkspaceSource = workspaceFile(
    'src/app/api/cron/shared/commit/commit-workspace.ts',
  );
  const cronStepsSource = workspaceFile(
    'src/app/api/cron/shared/cron-steps.ts',
  );

  it('checks the generation under lock before any finalization mutation', () => {
    const lock = sql.indexOf('FOR UPDATE;');
    const generationGuard = sql.indexOf(
      'v_execution_generation IS DISTINCT FROM',
    );
    const statusMutation = sql.indexOf(
      'INSERT INTO public.requirement_status',
    );
    const requirementMutation = sql.indexOf(
      "SET status = 'done'",
    );

    expect(lock).toBeGreaterThan(-1);
    expect(generationGuard).toBeGreaterThan(lock);
    expect(statusMutation).toBeGreaterThan(generationGuard);
    expect(requirementMutation).toBeGreaterThan(generationGuard);
    expect(sql).toContain(
      "metadata->>'requirement_id' = p_requirement_id::text",
    );
    expect(sql).toContain(
      'FROM PUBLIC, anon, authenticated',
    );
  });

  it('uses the fenced RPC and never performs broad sandbox deletion', () => {
    expect(finalizerSource).toContain('finalizeRequirementExecution({');
    expect(finalizerSource).toContain('expectedExecutionGeneration');
    expect(finalizerSource).not.toContain('deleteRequirementSandboxes(');
    expect(workflowSource).toContain(
      'if (sandboxId && executionIsCurrent)',
    );
  });

  it('preserves retry state until a terminal product result clears it', () => {
    expect(singleTurnSource).not.toContain('infra_retry_count');
    expect(terminalStepSql).toContain("'infra_retry_count', 0");
    expect(terminalStepSql).toContain(
      "IF p_status IN ('completed', 'failed') THEN",
    );
    expect(terminalStepSql).toContain(
      'FROM PUBLIC, anon, authenticated',
    );
  });

  it('preserves the resolved repository kind throughout the unified workflow', () => {
    expect(workflowSource).toContain('git_repo_kind: gitRepoKind');
    expect(workflowSource).toContain(
      'binding = await getRequirementGitBinding(reqId, gitRepoKind)',
    );
    expect(workflowSource).toContain(
      'binding = resolveDefaultGitBinding(gitRepoKind)',
    );
    expect(workflowSource).not.toContain("gitRepoKind: 'applications'");
    expect(workflowSource).not.toContain(
      "commitAndPushStep(sandboxId!, title, reqId, commitMsg, cronAudit, 'applications')",
    );
  });

  it('guards delivery side effects with flow capabilities', () => {
    expect(workflowSource).toContain(
      'requirementFlow.delivery.provision_tracking_script',
    );
    expect(workflowSource).toContain(
      'requirementFlow.delivery.apply_database_migrations',
    );
    expect(workflowSource).toContain(
      'requirementFlow.delivery.provision_app_tenant',
    );
    expect(workflowSource).toContain('executionPhaseCompleted = true');
    expect(workflowSource).toContain('executionPhaseCompleted &&');
    expect(workflowSource).toContain(
      'requirementFlow.delivery.validate_deployment',
    );
    expect(commitWorkspaceSource).toContain(
      'const validateDeployment = options?.validateDeployment ?? true',
    );
    expect(commitWorkspaceSource).toContain(
      'use_resolved_preview_only: !validateDeployment',
    );
    expect(workflowSource).toContain(
      'previewUrl = requirementFlow.delivery.validate_deployment',
    );
  });

  it('halts on tenant preflight errors without requesting product feedback', () => {
    expect(workflowSource).toMatch(
      /platformKeyResult = await provisionPlatformKeyStep\([\s\S]*?tenantProvisioningFailed = true;[\s\S]*?throw error;/,
    );
    expect(workflowSource).toContain(
      'wrapUpRequiresUserFeedback = !tenantProvisioningFailed;',
    );
  });

  it('requires confirmed persistence before lightweight finalization', () => {
    expect(workflowSource).toContain('pushResult?.ok === true');
    expect(cronStepsSource).toContain('ok: true');
    expect(cronStepsSource).toMatch(
      /if \(err\.sandboxReplacement\)[\s\S]*?ok: false/,
    );
  });

  it('halts delivery side effects while an origin precondition is missing', () => {
    expect(workflowSource).toMatch(
      /gateFailureKind === 'missing_precondition'[\s\S]*?infrastructureHalt = true;[\s\S]*?break outer;/,
    );
  });
});
