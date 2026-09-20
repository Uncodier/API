import {
  advancePhaseIfReadyInMemory,
  classifyRequirementType,
  getFlow,
  isLightRequirementFlow,
  productAttemptLimits,
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

describe('phase advancement blockers', () => {
  it('does not advance past a blocker that requires user action', () => {
    const flow = getFlow('app');
    const first = flow.phases[0];
    const second = flow.phases[1];
    const result = advancePhaseIfReadyInMemory({
      schema_version: 1,
      current_phase_id: first.id,
      completion_ratio: 0,
      cycles_spent_total: 0,
      items: [{
        id: 'blocked-item',
        title: 'Provide credentials',
        kind: 'integration',
        phase_id: first.id,
        acceptance: ['GET /api/provider returns 200'],
        status: 'pending',
        attempts: 0,
        scope_level: 'full',
        blocked_by: [{
          blocker_id: 'user-credential',
          category: 'user_decision',
          reason: 'Credential required.',
          resolution_actor: 'user',
          user_action_required: true,
        }],
      }, {
        id: 'later-item',
        title: 'Build page',
        kind: 'page',
        phase_id: second.id,
        acceptance: ['GET /dashboard returns 200'],
        status: 'pending',
        attempts: 0,
        scope_level: 'full',
      }],
    }, flow);

    expect(result).toBeNull();
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

  it('keeps product attempts separate from the cycle envelope', () => {
    const flow = getFlow('app');
    expect(flow.cost_envelope.max_cycles_per_item).toBe(50);
    expect(productAttemptLimits(flow)).toEqual({
      core: 4,
      ornamental: 2,
    });
  });
});
