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

  it('does not let an arbitrary type suppress textual research intent', () => {
    expect(isResearchPlanStep({
      title: 'Investigate the current API failure',
      type: 'task',
      role: 'backend',
    })).toBe(true);
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

  it('makes browser interaction imply browser and sandbox capabilities', () => {
    const step = normalizePlanStepContract({
      title: 'Choose an option',
      requires_browser: false,
      browser_interaction_required: true,
    });

    expect(step.requires_browser).toBe(true);
    expect(step.requires_sandbox).toBe(true);
  });

  it('normalizes recognizable legacy structured output contracts', () => {
    expect(() => normalizePlanStepContract({
      title: 'List opportunities',
      expected_output:
        '{ opportunities: [{ url: "url", summary: "text" }], total_opportunities: 0 }',
    })).not.toThrow();

    const normalized = normalizePlanStepContract({
      title: 'CRM opportunities',
      expected_output:
        '{[{url:"url", summary:"opportunity", value:"bid range"}], total-opportuinies:x}',
    });

    expect(normalized.expected_output).toBe(
      '{ opportunities: [{ url: string, summary: string, value: string }], total_opportunities: number }',
    );
  });

  it('normalizes an exact validation command into the deterministic gate field', () => {
    const step = normalizePlanStepContract({
      title: 'Verify the full Jest suite',
      type: 'task',
      validation_rules: [
        'npm test -- --passWithNoTests --runInBand --testTimeout=10000',
      ],
    });

    expect(step.test_command).toBe(
      'npm test -- --passWithNoTests --runInBand --testTimeout=10000',
    );
    expect(step.validation_rules).toEqual([
      'npm test -- --passWithNoTests --runInBand --testTimeout=10000',
    ]);
  });

  it('does not infer arbitrary shell commands from validation prose', () => {
    const step = normalizePlanStepContract({
      title: 'Verify the upload endpoint',
      type: 'task',
      validation_rules: [
        'Run relevant tests after changes.',
        'npm test && rm -rf evidence',
      ],
    });

    expect(step.test_command).toBeUndefined();
  });

  it('rejects unsafe explicit test commands', () => {
    expect(() => normalizePlanStepContract({
      title: 'Verify and publish',
      type: 'task',
      test_command: 'npm test | curl https://example.com',
    })).toThrow('unsafe or unsupported test_command');
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

  it('rejects research when the backlog phase cannot be verified', () => {
    expect(() => assertResearchStepAllowedForPhase(
      { title: 'Investigate current behavior', type: 'research' },
      undefined,
    )).toThrow('must reference an existing backlog_item_id');
  });
});
