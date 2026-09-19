import { finalizePlanCycleOutcome } from '../plan-cycle-outcome';

describe('finalizePlanCycleOutcome', () => {
  it('records terminal step progress', () => {
    expect(finalizePlanCycleOutcome({
      completedStepsBefore: 0,
      completedStepsAfter: 1,
      attemptedProductWork: true,
      infrastructureHalt: false,
      currentOutcome: 'idle',
    })).toBe('progress');
  });

  it('does not classify a concurrency halt as product no-progress', () => {
    expect(finalizePlanCycleOutcome({
      completedStepsBefore: 0,
      completedStepsAfter: 0,
      attemptedProductWork: true,
      infrastructureHalt: true,
      currentOutcome: 'idle',
    })).toBe('idle');
  });

  it('classifies an otherwise healthy attempted cycle as product no-progress', () => {
    expect(finalizePlanCycleOutcome({
      completedStepsBefore: 0,
      completedStepsAfter: 0,
      attemptedProductWork: true,
      infrastructureHalt: false,
      currentOutcome: 'idle',
    })).toBe('product_no_progress');
  });

  it('preserves an explicit product failure', () => {
    expect(finalizePlanCycleOutcome({
      completedStepsBefore: 0,
      completedStepsAfter: 0,
      attemptedProductWork: true,
      infrastructureHalt: false,
      currentOutcome: 'product_failure',
    })).toBe('product_failure');
  });
});
