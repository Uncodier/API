export const DEPLOYMENT_INFRASTRUCTURE_PROVENANCE =
  'deployment_infrastructure';
export const CRON_INFRASTRUCTURE_PROVENANCE = 'cron_infrastructure';
export const DEPLOYMENT_RECOVERY_VERSION = 1;

export interface DeploymentInfrastructureCorrelation {
  requirement_id: string;
  plan_id: string;
  step_id: string;
  commit_sha: string;
  branch: string;
  deployment_id?: string | null;
  git_repo_kind?: string;
}

export interface CronInfrastructureWait {
  kind: 'deployment' | 'sandbox' | 'gate';
  provenance:
    | typeof DEPLOYMENT_INFRASTRUCTURE_PROVENANCE
    | typeof CRON_INFRASTRUCTURE_PROVENANCE;
  correlation?: DeploymentInfrastructureCorrelation;
}

export interface ReadyDeploymentIdentity {
  requirementId: string;
  branch: string;
  commitSha: string;
  deploymentId?: string | null;
}

export interface GateDeploymentWaitDetails {
  deployState?: string;
  commitSha?: string;
  branch?: string;
  deploymentId?: string | null;
  gitRepoKind?: string;
}

export function buildGateInfrastructureWait(params: {
  deploy?: GateDeploymentWaitDetails;
  fallbackKind: 'sandbox' | 'gate';
  requirementId: string;
  planId: string;
  stepId: string;
}): CronInfrastructureWait {
  const { deploy, fallbackKind, requirementId, planId, stepId } = params;
  if (
    deploy?.deployState === 'pending' &&
    deploy.commitSha &&
    deploy.branch
  ) {
    return {
      kind: 'deployment',
      provenance: DEPLOYMENT_INFRASTRUCTURE_PROVENANCE,
      correlation: {
        requirement_id: requirementId,
        plan_id: planId,
        step_id: stepId,
        commit_sha: deploy.commitSha,
        branch: deploy.branch,
        deployment_id: deploy.deploymentId ?? null,
        git_repo_kind: deploy.gitRepoKind,
      },
    };
  }

  return {
    kind: fallbackKind,
    provenance: CRON_INFRASTRUCTURE_PROVENANCE,
  };
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function deploymentCorrelationMatches(
  correlation: DeploymentInfrastructureCorrelation | null | undefined,
  ready: ReadyDeploymentIdentity,
): boolean {
  if (!correlation) return false;
  return (
    normalized(correlation.requirement_id) === normalized(ready.requirementId) &&
    normalized(correlation.branch) === normalized(ready.branch) &&
    normalized(correlation.commit_sha) === normalized(ready.commitSha)
  );
}

export function getStepDeploymentCorrelation(
  step: Record<string, any>,
): DeploymentInfrastructureCorrelation | null {
  if (
    step.infrastructure_kind === 'deployment' &&
    step.infrastructure_failure_provenance ===
      DEPLOYMENT_INFRASTRUCTURE_PROVENANCE &&
    step.infrastructure_correlation
  ) {
    return step.infrastructure_correlation as DeploymentInfrastructureCorrelation;
  }
  const recovered = step.infrastructure_recovery;
  if (
    recovered?.provenance === DEPLOYMENT_INFRASTRUCTURE_PROVENANCE &&
    recovered?.correlation
  ) {
    return recovered.correlation as DeploymentInfrastructureCorrelation;
  }
  return null;
}
