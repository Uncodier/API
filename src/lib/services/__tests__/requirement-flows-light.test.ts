import { classifyRequirementType, isLightRequirementFlow } from '@/lib/services/requirement-flows';

describe('isLightRequirementFlow', () => {
  it('treats research as makinari / light', () => {
    expect(classifyRequirementType('research')).toBe('makinari');
    expect(isLightRequirementFlow('research')).toBe(true);
    expect(isLightRequirementFlow('makinari')).toBe(true);
    expect(isLightRequirementFlow('doc')).toBe(true);
    expect(isLightRequirementFlow('task')).toBe(true);
  });

  it('keeps app/site/automation heavy', () => {
    expect(isLightRequirementFlow('app')).toBe(false);
    expect(isLightRequirementFlow('site')).toBe(false);
    expect(isLightRequirementFlow('automation')).toBe(false);
  });
});
