import { describe, expect, it } from '@jest/globals';
import { resolveExecuteStepId } from '../resolve-execute-step';

const steps = [
  { id: '11111111-1111-4111-8111-111111111111', title: 'Write blueprint', order: 1 },
  { id: '22222222-2222-4222-8222-222222222222', title: 'Review channels', order: 2 },
];

describe('resolveExecuteStepId', () => {
  it('resolves a matching UUID', () => {
    const res = resolveExecuteStepId({ step_id: steps[0].id, steps });
    expect(res.stepId).toBe(steps[0].id);
    expect(res.error).toBeUndefined();
  });

  it('resolves by title', () => {
    const res = resolveExecuteStepId({ title: 'review channels', steps });
    expect(res.stepId).toBe(steps[1].id);
  });

  it('resolves by order', () => {
    const res = resolveExecuteStepId({ order: 2, steps });
    expect(res.stepId).toBe(steps[1].id);
  });

  it('returns an actionable error when nothing matches', () => {
    const res = resolveExecuteStepId({ step_id: 'not-a-step', steps });
    expect(res.stepId).toBeNull();
    expect(res.error).toMatch(/Could not resolve execute_step/);
    expect(res.error).toMatch(/Write blueprint/);
  });
});
