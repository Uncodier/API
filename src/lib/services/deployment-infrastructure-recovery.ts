import { supabaseAdmin } from '@/lib/database/supabase-client';
import {
  DEPLOYMENT_RECOVERY_VERSION,
  type ReadyDeploymentIdentity,
} from './cron-infrastructure-state';

export interface DeploymentRecoveryInput extends ReadyDeploymentIdentity {
  siteId: string;
  instanceId?: string | null;
  previewUrl?: string | null;
  deploymentId?: string | null;
  allowLegacySystemCircuit?: boolean;
}

export interface DeploymentRecoveryResult {
  matched: boolean;
  recovered: boolean;
  requirementReopened: boolean;
  planIds: string[];
  stepIds: string[];
  state?: string;
}

export class DeploymentRecoveryDatabaseError extends Error {
  readonly code?: string;
  readonly details?: string;
  readonly hint?: string;

  constructor(error: {
    message: string;
    code?: string;
    details?: string;
    hint?: string;
  }) {
    super(`Atomic deployment recovery failed: ${error.message}`);
    this.name = 'DeploymentRecoveryDatabaseError';
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = error.code;
    this.details = error.details;
    this.hint = error.hint;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function deploymentRecoveryIdentity(
  input: Pick<DeploymentRecoveryInput, 'branch' | 'commitSha'>,
): string {
  return `v${DEPLOYMENT_RECOVERY_VERSION}:${input.branch}:${input.commitSha}`;
}

export async function reconcileReadyDeployment(
  input: DeploymentRecoveryInput,
): Promise<DeploymentRecoveryResult> {
  const { data, error } = await supabaseAdmin.rpc(
    'recover_ready_deployment_infrastructure',
    {
      p_requirement_id: input.requirementId,
      p_site_id: input.siteId,
      p_instance_id: input.instanceId ?? null,
      p_branch: input.branch,
      p_commit_sha: input.commitSha,
      p_deployment_id: input.deploymentId ?? null,
      p_preview_url: input.previewUrl ?? null,
      p_recovery_id: deploymentRecoveryIdentity(input),
      p_allow_legacy: input.allowLegacySystemCircuit ?? false,
    },
  );
  if (error) {
    throw new DeploymentRecoveryDatabaseError(error);
  }
  if (
    !data ||
    typeof data.matched !== 'boolean' ||
    typeof data.recovered !== 'boolean' ||
    typeof data.requirement_reopened !== 'boolean'
  ) {
    throw new Error('Deployment recovery RPC returned an invalid result');
  }
  return {
    state: typeof data.state === 'string' ? data.state : undefined,
    matched: data.matched,
    recovered: data.recovered,
    requirementReopened: data.requirement_reopened,
    planIds: stringArray(data.plan_ids),
    stepIds: stringArray(data.step_ids),
  };
}
