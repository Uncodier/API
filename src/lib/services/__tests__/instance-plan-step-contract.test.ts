import {
  assertCompatiblePlanStepAssignment,
  assertKnownPlanStepSkill,
  hasExplicitBlockingResearchContract,
  isResearchPlanStep,
  normalizePlanStepContract,
  assertResearchStepAllowedForPhase,
} from '../instance-plan-step-contract';

describe('instance plan step contracts', () => {
  it('assigns the investigation skill and bounded completion contract', () => {
    const step = normalizePlanStepContract({
      title: 'Investigate current upload errors',
      type: 'research',
      skill: 'makinari-rol-frontend',
      instructions: 'Inspect the upload route.',
    });

    expect(step.role).toBe('investigate');
    expect(step.skill).toBe('makinari-fase-investigacion');
    expect(step.expected_output).toContain('not reproducible');
    expect(step.success_criteria).toContain(
      'Run each targeted diagnostic at most once unless its inputs changed.',
    );
    expect(step.validation_rules).toContain(
      'Passing checks are valid evidence; do not keep searching for a historical failure.',
    );
  });

  it('normalizes specialized research to the bounded investigation skill', () => {
    const step = normalizePlanStepContract({
      title: 'Research Supabase storage behavior',
      type: 'research',
      skill: 'makinari-obj-apps-supabase',
    });

    expect(step.skill).toBe('makinari-fase-investigacion');
    expect(step.role).toBe('investigate');
  });

  it('treats an investigate role as research even when type is task', () => {
    const step = normalizePlanStepContract({
      title: 'Inspect the current implementation',
      type: 'task',
      role: 'investigate',
    });

    expect(isResearchPlanStep(step)).toBe(true);
    expect(step.skill).toBe('makinari-fase-investigacion');
  });

  it('derives a verifiable contract for implementation steps', () => {
    const step = normalizePlanStepContract({
      title: 'Implement upload endpoint',
      type: 'task',
      test_command: 'npm test -- upload.test.ts',
    });

    expect(step.expected_output).toContain('Implement upload endpoint');
    expect(step.success_criteria).toHaveLength(2);
    expect(step.validation_rules).toEqual([
      'The command "npm test -- upload.test.ts" exits successfully.',
    ]);
  });

  it('derives canonical skills from roles and rejects canonical conflicts', () => {
    expect(normalizePlanStepContract({
      title: 'Implement API',
      role: 'backend',
    }).skill).toBe('makinari-rol-backend');

    expect(() => assertCompatiblePlanStepAssignment({
      title: 'Implement API',
      role: 'backend',
      skill: 'makinari-rol-frontend',
    })).toThrow('incompatible role');
  });

  it('rejects unknown explicit skills through the supplied registry', () => {
    expect(() => assertKnownPlanStepSkill(
      { title: 'Unknown work', skill: 'missing-skill' },
      () => false,
    )).toThrow('unknown skill');
    expect(() => assertKnownPlanStepSkill(
      { title: 'Known work', skill: 'known-skill' },
      (skill) => skill === 'known-skill',
    )).not.toThrow();
  });

  it('recognizes only explicitly identified blocking research', () => {
    expect(isResearchPlanStep({
      title: 'Inspect current implementation',
    })).toBe(true);
    expect(hasExplicitBlockingResearchContract({
      title: 'Investigate provider behavior',
      expected_output: 'A provider compatibility decision.',
      success_criteria: ['The supported API is identified.'],
      metadata: { blocking_unknown: 'The provider API version is unknown.' },
    })).toBe(true);
    expect(hasExplicitBlockingResearchContract({
      title: 'Investigate provider behavior',
      expected_output: 'A provider compatibility decision.',
      success_criteria: ['The supported API is identified.'],
    })).toBe(false);
  });

  it('does not treat generated research defaults as an explicit contract', () => {
    const source = {
      title: 'Investigate provider behavior',
      type: 'research',
      metadata: { blocking_unknown: 'The provider API version is unknown.' },
    };
    const normalized = normalizePlanStepContract(source);

    expect(() => assertResearchStepAllowedForPhase(
      normalized,
      'build',
      source,
    )).toThrow('Standalone research step');
  });
});
