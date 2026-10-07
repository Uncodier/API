jest.mock('@/lib/services/workflow-service', () => ({ WorkflowService: {} }));
import { withinSetupDeadline } from '../setup-feedback';

it('bounds unconfirmed operations without replaying or canceling an accepted operation', async () => {
  jest.useFakeTimers();
  try {
    const operation = jest.fn(() => new Promise<never>(() => {}));
    const bounded = withinSetupDeadline(operation(), 100);
    const assertion = expect(bounded).rejects.toMatchObject({ code: 'SETUP_UNCONFIRMED', status: 503 });
    await jest.advanceTimersByTimeAsync(100);
    await assertion;
    expect(operation).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});