import { assertBudget, budgetRemaining, getRequirementCycleBudget } from '../requirement-cost-envelope';
import { getFlow } from '../requirement-flows';

describe('requirement cost envelope', () => {
  it('uses registry limits for the scheduler and bounds large backlogs', () => {
    const envelope = getFlow('app').cost_envelope;
    expect(getRequirementCycleBudget('app', 2)).toEqual({
      perItem: envelope.max_cycles_per_item,
      requirement: envelope.max_cycles_per_item * 2,
    });
    expect(getRequirementCycleBudget('app', 1000).requirement)
      .toBe(envelope.max_cycles_per_requirement);
    expect(getRequirementCycleBudget('app', 1000, '999999').requirement)
      .toBe(envelope.max_cycles_per_requirement);
  });

  it.each(['0', '-1', '2.5', 'invalid', ''])('rejects invalid override %s', override => {
    expect(getRequirementCycleBudget('app', 0, override).perItem)
      .toBe(getFlow('app').cost_envelope.max_cycles_per_item);
  });

  it('enforces and reports the requirement budget instead of an unlimited sentinel', () => {
    const usage = { cycles_used_item: 0, turns_used_step: 0,
      cycles_used_requirement: getFlow('app').cost_envelope.max_cycles_per_requirement };
    expect(() => assertBudget('app', usage)).toThrow('scope=requirement');
    expect(budgetRemaining('app', usage).requirement).toBe(0);
  });

  it('enforces the declared per-step turn cap', () => {
    expect(() => assertBudget('app', { cycles_used_item: 0, cycles_used_requirement: 0,
      turns_used_step: getFlow('app').cost_envelope.max_turns_per_step })).toThrow('scope=step');
  });
});