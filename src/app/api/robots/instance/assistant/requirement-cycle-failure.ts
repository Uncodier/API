import { AssistantExecutionBoundaryError } from '@/lib/services/robot-instance/assistant-execution-boundary';

/** Pure host boundary: importing the classifier must not load database I/O. */
export class RequirementBudgetError extends Error {
  constructor(readonly code: 'configuration_invalid' | 'evaluation_unavailable') {
    super(code === 'configuration_invalid'
      ? 'Invalid requirement monetary budget'
      : 'Requirement monetary budget evaluation unavailable');
    this.name = 'RequirementBudgetError';
  }
}

/** Only host-classified safe boundaries yield; unknown storage/accounting stays fenced. */
export function requirementCycleFailure(error: unknown): { status: 'waiting' | 'paused'; reason: string } | undefined {
  // Configuration/accounting stops require explicit operator recovery, not an
  // exhausted-budget receipt that can automatically resume after a credit refill.
  if (error instanceof RequirementBudgetError) {
    return { status: 'paused', reason: `requirement_budget_${error.code}` };
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if ((error.name === 'SandboxBillingError' && code === 'insufficient_credits')
      || (error.name === 'WorkspaceError' && code === 'WORKSPACE_CREDITS_REQUIRED')) {
      return { status: 'paused', reason: 'sandbox_credits_required' };
    }
    if ((error.name === 'SandboxBillingError' && code === 'reconciliation_pending')
      || (error.name === 'WorkspaceError' && code === 'WORKSPACE_BILLING_UNAVAILABLE')) {
      return { status: 'paused', reason: 'sandbox_reconciliation_required' };
    }
  }
  if (error instanceof AssistantExecutionBoundaryError) {
    if (error.code === 'canonical_slice_interrupted' || error.code === 'canonical_audit_unavailable' || error.code === 'model_predispatch_cancelled') {
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