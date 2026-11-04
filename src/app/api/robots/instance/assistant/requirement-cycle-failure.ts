import { AssistantExecutionBoundaryError } from '@/lib/services/robot-instance/assistant-execution-boundary';

/** Only host-classified safe boundaries yield; unknown storage/accounting stays fenced. */
export function requirementCycleFailure(error: unknown): { status: 'waiting' | 'paused'; reason: string } | undefined {
  if (error instanceof AssistantExecutionBoundaryError) {
    if (error.code === 'canonical_slice_interrupted' || error.code === 'canonical_audit_unavailable') {
      return { status: 'waiting', reason: error.code };
    }
    return { status: 'paused', reason: `assistant_execution_${error.code}` };
  }
  if (error instanceof Error && error.name === 'OpenRouterBillingError') {
    return { status: 'paused', reason: 'assistant_billing_unconfirmed' };
  }
  if (error instanceof Error && error.name === 'RecoveryError') {
    return { status: 'paused', reason: 'assistant_execution_boundary_failed' };
  }
}