import { WorkflowService } from '@/lib/services/workflow-service';
import { SiteSetupError } from './setup-request';

/** A deadline never cancels or replays a potentially accepted Temporal start. */
export async function withinSetupDeadline<T>(operation: Promise<T>, milliseconds = 6_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SiteSetupError(503, 'SETUP_UNCONFIRMED',
        'Site setup could not be confirmed. Check its status before retrying.')), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readSetupFeedback(workflowId: string) {
  // The existing service describes first and reads result() only for a closed execution.
  const result = await withinSetupDeadline(
    WorkflowService.getInstance().getFinishedWorkflowResult(workflowId), 4_000,
  );
  if (result.workflowId !== workflowId) {
    throw new SiteSetupError(502, 'WORKFLOW_STATUS_ERROR', 'Unable to verify the site setup workflow status');
  }
  const status = result.status?.toLowerCase();
  if (status === 'running' && result.success) {
    return { workflow_id: workflowId, status: 'running', setup_status: 'pending', cause: 'WORKFLOW_RUNNING' };
  }
  if (['failed', 'canceled', 'cancelled', 'terminated', 'timed_out'].includes(status || '')) {
    return { workflow_id: workflowId, status, setup_status: 'failed', cause: 'WORKFLOW_DID_NOT_COMPLETE' };
  }
  if (!result.success || status !== 'completed') {
    throw new SiteSetupError(503, 'WORKFLOW_STATUS_ERROR', 'Unable to retrieve the site setup workflow status');
  }
  // Explicit worker-owned completion only; old/unknown payloads are not proof of full setup.
  const data = result.data as { status?: unknown; success?: unknown; steps?: Record<string, { status?: unknown; reason?: unknown }> } | undefined;
  const setupStatus = data?.status === 'completed' && data.success === true ? 'complete'
    : data?.status === 'partial' ? 'partial' : data?.status === 'failed' ? 'failed' : 'unconfirmed';
  const steps: Record<string, string> = {};
  const stepCauses: Record<string, string> = {};
  const allowedCauses = ['missing_user_id', 'missing_site_url', 'missing_contact_email', 'disabled',
    'agent_creation_incomplete', 'agent_creation_failed', 'segment_creation_incomplete', 'segment_creation_failed',
    'account_manager_assignment_failed', 'follow_up_email_failed', 'account_manager_api_unavailable', 'email_provider_skipped',
    'setup_email_delivery_unconfirmed', 'setup_email_service_unconfigured'];
  for (const name of ['agents', 'segments', 'account_manager', 'follow_up_email']) {
    const value = data?.steps?.[name]?.status;
    if (typeof value === 'string' && ['completed', 'partial', 'skipped', 'failed'].includes(value)) steps[name] = value;
    const reason = data?.steps?.[name]?.reason;
    if (typeof reason === 'string' && allowedCauses.includes(reason)) stepCauses[name] = reason;
  }
  return {
    workflow_id: workflowId, status: 'completed', setup_status: setupStatus, steps, step_causes: stepCauses,
    cause: setupStatus === 'complete' ? 'SETUP_COMPLETE'
      : setupStatus === 'partial' ? 'SETUP_PARTIAL' : setupStatus === 'failed' ? 'SETUP_FAILED' : 'SETUP_RESULT_UNCONFIRMED',
  };
}