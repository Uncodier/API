import { supabaseAdmin } from '@/lib/database/supabase-client';
import { randomUUID } from 'node:crypto';
import {
  DEPLOYMENT_INFRASTRUCTURE_PROVENANCE,
  getStepDeploymentCorrelation,
} from './cron-infrastructure-state';
import {
  fetchGitHubBranchTipSha,
  pollGitHubDeploymentForSha,
} from './github-deployment-status';
import { getRequirementGitBinding } from './requirement-git-binding';
import { parseGithubTreeUrl } from './requirement-branch';
import { reconcileReadyDeployment } from './deployment-infrastructure-recovery';

type PlanRow = {
  id: string;
  updated_at?: string | null;
  instance_id?: string | null;
  site_id?: string | null;
  metadata?: Record<string, any> | null;
  steps?: Array<Record<string, any>> | null;
};

type RecoveryCandidate = {
  requirementId: string;
  siteId: string;
  instanceId?: string | null;
  branch: string;
  commitSha: string;
  gitRepoKind?: string;
  allowLegacySystemCircuit: boolean;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_SCAN_LEASE_KEY = 'deployment-infrastructure';
const RECOVERY_SCAN_LEASE_TTL_SECONDS = 900;
const ACTIVE_DEPLOYMENT_WAIT_FILTER = JSON.stringify([{
  infrastructure_kind: 'deployment',
  infrastructure_failure_provenance:
    DEPLOYMENT_INFRASTRUCTURE_PROVENANCE,
}]);

async function acquireRecoveryScanLease(ownerId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc(
    'acquire_deployment_recovery_scan_lease',
    {
      p_lease_key: RECOVERY_SCAN_LEASE_KEY,
      p_owner_id: ownerId,
      p_ttl_seconds: RECOVERY_SCAN_LEASE_TTL_SECONDS,
    },
  );
  if (error) {
    throw new Error(`Failed to acquire deployment recovery lease: ${error.message}`);
  }
  return data === true;
}

async function releaseRecoveryScanLease(ownerId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc(
    'release_deployment_recovery_scan_lease',
    {
      p_lease_key: RECOVERY_SCAN_LEASE_KEY,
      p_owner_id: ownerId,
    },
  );
  if (error) {
    throw new Error(`Failed to release deployment recovery lease: ${error.message}`);
  }
}

function configuredLegacyRequirementIds(): Set<string> {
  return new Set(
    (process.env.CRON_LEGACY_DEPLOYMENT_RECOVERY_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => UUID_RE.test(value)),
  );
}

function isActiveDeploymentWait(step: Record<string, any>): boolean {
  return (
    step.infrastructure_kind === 'deployment' &&
    step.infrastructure_failure_provenance ===
      DEPLOYMENT_INFRASTRUCTURE_PROVENANCE &&
    (
      step.infrastructure_waiting === true ||
      step.infrastructure_circuit_open === true
    )
  );
}

function hasLegacyDeploymentTimeout(plan: PlanRow): boolean {
  return (plan.steps ?? []).some((step) =>
    /(?:deploy gate|deployment).*(?:timeout|timed out|in time)/i.test(
      `${step.error_message || ''}\n${step.infrastructure_error || ''}`,
    ),
  );
}

async function loadLegacyPlans(
  requirementId: string,
): Promise<{ plans: PlanRow[]; runnerInstanceId: string | null }> {
  const requirement = await supabaseAdmin
    .from('requirements')
    .select('metadata')
    .eq('id', requirementId)
    .maybeSingle();
  if (requirement.error) {
    throw new Error(
      `Failed to load allowlisted legacy requirement: ${requirement.error.message}`,
    );
  }
  const runnerInstanceId =
    typeof requirement.data?.metadata?.runner_instance_id === 'string'
      ? requirement.data.metadata.runner_instance_id
      : null;

  const byRequirement = await supabaseAdmin
    .from('instance_plans')
    .select('id, instance_id, site_id, status, metadata, steps')
    .contains('metadata', { requirement_id: requirementId })
    .in('status', ['pending', 'in_progress', 'active', 'paused', 'failed', 'blocked'])
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(50);
  if (byRequirement.error) {
    throw new Error(
      `Failed to load legacy plans by requirement: ${byRequirement.error.message}`,
    );
  }

  let byRunner: { data: PlanRow[] | null; error: any } = {
    data: [],
    error: null,
  };
  if (runnerInstanceId) {
    byRunner = await supabaseAdmin
      .from('instance_plans')
      .select('id, instance_id, site_id, status, metadata, steps')
      .eq('instance_id', runnerInstanceId)
      .in('status', ['pending', 'in_progress', 'active', 'paused', 'failed', 'blocked'])
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(50);
    if (byRunner.error) {
      throw new Error(
        `Failed to load legacy plans by runner: ${byRunner.error.message}`,
      );
    }
  }

  const plans = new Map<string, PlanRow>();
  for (const plan of [
    ...((byRequirement.data ?? []) as PlanRow[]),
    ...((byRunner.data ?? []) as PlanRow[]),
  ]) {
    const boundRequirementId = plan.metadata?.requirement_id;
    if (
      typeof boundRequirementId === 'string' &&
      boundRequirementId !== requirementId
    ) {
      continue;
    }
    plans.set(plan.id, plan);
  }
  return { plans: Array.from(plans.values()), runnerInstanceId };
}

async function addLegacyCandidates(
  candidates: RecoveryCandidate[],
  requirementId: string,
): Promise<void> {
  const status = await supabaseAdmin
    .from('requirement_status')
    .select('stage, message, repo_url, site_id, instance_id')
    .eq('requirement_id', requirementId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (status.error) {
    throw new Error(
      `Failed to load legacy deployment audit: ${status.error.message}`,
    );
  }
  const auditedDeploymentBlock =
    status.data?.stage === 'blocked' &&
    /(?:deploy gate|deployment).*(?:timeout|timed out|in time)/i.test(
      status.data?.message || '',
    );
  if (!auditedDeploymentBlock) return;

  const { plans, runnerInstanceId } = await loadLegacyPlans(requirementId);
  const legacyPlan = plans.find(
    (plan) => plan.site_id && hasLegacyDeploymentTimeout(plan),
  );
  if (!legacyPlan) return;

  const branch = parseGithubTreeUrl(status.data?.repo_url || '')?.branch;
  if (!branch) return;
  const binding = await getRequirementGitBinding(requirementId);
  const commitSha = await fetchGitHubBranchTipSha(
    binding.org,
    binding.repo,
    branch,
  );
  if (!commitSha) return;
  candidates.push({
    requirementId,
    siteId: legacyPlan.site_id!,
    instanceId:
      legacyPlan.instance_id ||
      runnerInstanceId ||
      status.data?.instance_id ||
      null,
    branch,
    commitSha,
    allowLegacySystemCircuit: true,
  });
}

async function* streamActiveDeploymentCandidatePages(
  pageSize: number,
): AsyncGenerator<RecoveryCandidate[]> {
  let cursorId: string | null = null;
  for (;;) {
    let query = supabaseAdmin
      .from('instance_plans')
      .select('id, instance_id, site_id, status, metadata, steps')
      .in('status', ['pending', 'in_progress', 'active', 'paused', 'failed', 'blocked'])
      // PostgREST expects a JSON literal for jsonb array containment.
      // Passing an array directly is encoded as `{[object Object]}`.
      .contains('steps', ACTIVE_DEPLOYMENT_WAIT_FILTER)
      .order('id', { ascending: true });
    if (cursorId) {
      query = query.gt('id', cursorId);
    }
    const result = await query.limit(pageSize);
    if (result.error) {
      throw new Error(
        `Failed to scan deployment waits: ${result.error.message}`,
      );
    }
    const plans = (result.data ?? []) as PlanRow[];
    const candidates: RecoveryCandidate[] = [];
    for (const plan of plans) {
      if (!plan.site_id) continue;
      for (const step of plan.steps ?? []) {
        if (!isActiveDeploymentWait(step)) continue;
        const correlation = getStepDeploymentCorrelation(step);
        if (
          !correlation ||
          correlation.plan_id !== plan.id ||
          correlation.step_id !== step.id
        ) {
          continue;
        }
        candidates.push({
          requirementId: correlation.requirement_id,
          siteId: plan.site_id,
          instanceId: plan.instance_id,
          branch: correlation.branch,
          commitSha: correlation.commit_sha,
          gitRepoKind: correlation.git_repo_kind,
          allowLegacySystemCircuit: false,
        });
      }
    }
    if (candidates.length > 0) {
      yield candidates;
    }
    if (plans.length < pageSize) break;
    cursorId = plans[plans.length - 1].id;
  }
}

export async function reconcilePendingDeploymentInfrastructureWaits(
  pageSize = 50,
): Promise<{ checked: number; recovered: number }> {
  const leaseOwner = randomUUID();
  if (!(await acquireRecoveryScanLease(leaseOwner))) {
    return { checked: 0, recovered: 0 };
  }
  try {
    const boundedPageSize = Math.min(100, Math.max(1, pageSize));
    let recovered = 0;
    const seen = new Set<string>();
    const processCandidates = async (
      candidates: RecoveryCandidate[],
    ): Promise<void> => {
      for (const candidate of candidates) {
        const key =
          `${candidate.requirementId}:${candidate.branch}:${candidate.commitSha}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const binding = await getRequirementGitBinding(
            candidate.requirementId,
            candidate.gitRepoKind,
          );
          const poll = await pollGitHubDeploymentForSha(
            binding.org,
            binding.repo,
            candidate.commitSha,
            { maxAttempts: 1, pollIntervalMs: 0 },
          );
          if (poll.state !== 'success' || !poll.previewUrl) continue;
          const result = await reconcileReadyDeployment({
            ...candidate,
            previewUrl: poll.previewUrl,
            deploymentId: poll.vercelDeploymentId ?? null,
          });
          if (result.recovered) recovered++;
        } catch (error) {
          console.warn(
            `[DeploymentRecovery] Candidate ${candidate.requirementId} failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    };

    for await (const candidates of streamActiveDeploymentCandidatePages(
      boundedPageSize,
    )) {
      await processCandidates(candidates);
    }

    const legacyCandidates: RecoveryCandidate[] = [];
    for (const requirementId of Array.from(configuredLegacyRequirementIds())) {
      await addLegacyCandidates(legacyCandidates, requirementId);
    }
    await processCandidates(legacyCandidates);
    return { checked: seen.size, recovered };
  } finally {
    try {
      await releaseRecoveryScanLease(leaseOwner);
    } catch (error) {
      console.warn(
        '[DeploymentRecovery] Failed to release scan lease:',
        error instanceof Error ? error.message : error,
      );
    }
  }
}
