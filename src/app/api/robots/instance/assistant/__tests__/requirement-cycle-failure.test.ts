import { requirementCycleFailure, RequirementBudgetError } from '../requirement-cycle-failure';
import { AssistantExecutionBoundaryError } from '@/lib/services/robot-instance/assistant-execution-boundary';

test.each(['canonical_slice_interrupted', 'canonical_audit_unavailable', 'model_predispatch_cancelled'] as const)('only trusted %s yields', code => {
  expect(requirementCycleFailure(new AssistantExecutionBoundaryError(code))).toEqual({ status: 'waiting', reason: code });
  expect(requirementCycleFailure(Object.assign(new Error('Untrusted code'), { name: 'RecoveryError', code })))
    .toEqual({ status: 'paused', reason: 'assistant_execution_boundary_failed' });
});

test.each(['boundary_failed', 'execution_check_failed', 'session_lease_failed', 'session_save_failed', 'assistant_log_failed'] as const)(
  'unverified %s remains paused with a specific reason', code => {
    expect(requirementCycleFailure(new AssistantExecutionBoundaryError(code)))
      .toEqual({ status: 'paused', reason: `assistant_execution_${code}` });
  });

test('billing uncertainty remains fenced, ordinary errors retain caller policy', () => {
  expect(requirementCycleFailure(Object.assign(new Error('Offline billing failure'), { name: 'OpenRouterBillingError' })))
    .toEqual({ status: 'paused', reason: 'assistant_billing_unconfirmed' });
  expect(requirementCycleFailure(new Error('Offline runtime failure'))).toBeUndefined();
});

test.each(['configuration_invalid', 'evaluation_unavailable'] as const)('typed budget %s is not an economic auto-recovery pause', code => {
  expect(requirementCycleFailure(new RequirementBudgetError(code)))
    .toEqual({ status: 'paused', reason: `requirement_budget_${code}` });
  expect(requirementCycleFailure(Object.assign(new Error('Invalid requirement monetary budget'), { code }))).toBeUndefined();
});

test.each([
  ['SandboxBillingError', 'insufficient_credits', 'sandbox_credits_required'],
  ['SandboxBillingError', 'reconciliation_pending', 'sandbox_reconciliation_required'],
  ['WorkspaceError', 'WORKSPACE_CREDITS_REQUIRED', 'sandbox_credits_required'],
  ['WorkspaceError', 'WORKSPACE_BILLING_UNAVAILABLE', 'sandbox_reconciliation_required'],
])('host %s code %s pauses even outside workspace execution', (name, code, reason) => {
  expect(requirementCycleFailure(Object.assign(new Error('Offline billing boundary'), { name, code })))
    .toEqual({ status: 'paused', reason });
  expect(requirementCycleFailure(Object.assign(new Error('Untrusted code'), { code }))).toBeUndefined();
});