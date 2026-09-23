import { describe, expect, it } from '@jest/globals';
import {
  finalizePlanCycleOutcome,
  selectCycleAccountingScope,
  shouldPersistCycleWorkspace,
  shouldUseLightweightCycleFinalization,
} from '../plan-cycle-outcome';

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

  it('persists safe workspace changes while an infrastructure halt blocks delivery', () => {
    expect(shouldPersistCycleWorkspace({
      infrastructureHalt: true,
      persistWorkspaceOnInfrastructureHalt: true,
    })).toBe(true);
    expect(shouldPersistCycleWorkspace({
      infrastructureHalt: true,
      persistWorkspaceOnInfrastructureHalt: false,
    })).toBe(false);
  });

  it('preserves an explicit product failure despite workspace changes', () => {
    expect(finalizePlanCycleOutcome({
      completedStepsBefore: 0,
      completedStepsAfter: 0,
      attemptedProductWork: true,
      durableProductProgress: true,
      infrastructureHalt: false,
      currentOutcome: 'product_failure',
    })).toBe('product_failure');
  });

  it('records durable persisted changes before a step completes', () => {
    expect(finalizePlanCycleOutcome({
      completedStepsBefore: 0,
      completedStepsAfter: 0,
      attemptedProductWork: true,
      durableProductProgress: true,
      infrastructureHalt: false,
      currentOutcome: 'product_no_progress',
    })).toBe('progress');
  });

  it('uses lightweight finalization only for healthy unfinished progress', () => {
    expect(shouldUseLightweightCycleFinalization({
      planCompleted: false,
      anyStepFailed: false,
      infrastructureHalt: false,
      cycleOutcome: 'progress',
    })).toBe(true);
    expect(shouldUseLightweightCycleFinalization({
      planCompleted: false,
      anyStepFailed: true,
      infrastructureHalt: false,
      cycleOutcome: 'product_failure',
    })).toBe(false);
    expect(shouldUseLightweightCycleFinalization({
      planCompleted: true,
      anyStepFailed: false,
      infrastructureHalt: false,
      cycleOutcome: 'progress',
    })).toBe(false);
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

  it('attributes aggregate progress to the step that produced it', () => {
    expect(selectCycleAccountingScope({
      outcome: 'progress',
      attemptedPlanId: 'plan-1',
      attemptedStepId: 'last-attempted',
      progressPlanId: 'plan-1',
      progressStepId: 'made-progress',
    })).toEqual({
      planId: 'plan-1',
      stepId: 'made-progress',
    });
  });
});
