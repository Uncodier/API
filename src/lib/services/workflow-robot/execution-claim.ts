import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const WORKFLOW_CLAIM_LEASE_SECONDS = 60 * 60;

export interface WorkflowRunClaim {
  token: string;
  expiresAt: string;
}

export async function claimWorkflowRunExecution(
  runPlanId: string,
): Promise<WorkflowRunClaim | null> {
  const token = randomUUID();
  const { data, error } = await supabaseAdmin.rpc(
    'claim_workflow_run_execution',
    {
      p_run_plan_id: runPlanId,
      p_claim_token: token,
      p_lease_seconds: WORKFLOW_CLAIM_LEASE_SECONDS,
    },
  );
  if (error) {
    throw new Error(`Failed to claim workflow run: ${error.message}`);
  }
  if (data?.state === 'busy') return null;
  if (data?.state !== 'claimed' || typeof data.claim_expires_at !== 'string') {
    throw new Error('Workflow run claim RPC returned an invalid result');
  }
  return { token, expiresAt: data.claim_expires_at };
}

export async function renewWorkflowRunExecutionClaim(
  runPlanId: string,
  claimToken: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc(
    'renew_workflow_run_execution_claim',
    {
      p_run_plan_id: runPlanId,
      p_claim_token: claimToken,
      p_lease_seconds: WORKFLOW_CLAIM_LEASE_SECONDS,
    },
  );
  if (error) {
    throw new Error(`Failed to renew workflow run claim: ${error.message}`);
  }
  return data === true;
}

export async function finishWorkflowRunExecution(
  runPlanId: string,
  claimToken: string,
  status: 'pending' | 'completed' | 'failed' | 'cancelled',
  errorMessage?: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc(
    'finish_workflow_run_execution',
    {
      p_run_plan_id: runPlanId,
      p_claim_token: claimToken,
      p_status: status,
      p_error_message: errorMessage || null,
    },
  );
  if (error) {
    throw new Error(`Failed to finish workflow run claim: ${error.message}`);
  }
  return data === true;
}
