import {
  classifyRequirementType,
  getFlow,
  isLightRequirementFlow,
} from '@/lib/services/requirement-flows';

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

describe('flow delivery capabilities', () => {
  it('declares application, automation, and light-flow delivery policies', () => {
    expect(getFlow('app').delivery).toEqual({
      provision_tracking_script: true,
      apply_database_migrations: true,
      provision_app_tenant: true,
      validate_deployment: true,
    });
    expect(getFlow('site').delivery).toEqual(getFlow('app').delivery);

    expect(getFlow('automation').delivery).toEqual({
      provision_tracking_script: false,
      apply_database_migrations: false,
      provision_app_tenant: true,
      validate_deployment: true,
    });

    for (const kind of [
      'doc',
      'presentation',
      'contract',
      'task',
      'makinari',
    ] as const) {
      expect(getFlow(kind).delivery).toEqual({
        provision_tracking_script: false,
        apply_database_migrations: false,
        provision_app_tenant: false,
        validate_deployment: false,
      });
    }
  });
});
