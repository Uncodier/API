import { requirementCycleFailure } from '../requirement-cycle-failure';
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