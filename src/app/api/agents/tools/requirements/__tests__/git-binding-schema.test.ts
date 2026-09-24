import { PartialRequirementMetadataSchema } from '../git-binding-schema';

describe('requirement metadata trust boundary', () => {
  it.each([
    'runner_instance_id',
    'requirement_execution_generation',
    'requirement_last_resume_action_id',
    'requirement_last_resume_reopened_plans',
    'cron_attempts',
  ])('rejects runner-owned metadata key %s', (key) => {
    expect(() => PartialRequirementMetadataSchema.parse({
      [key]: 'forged-value',
    })).toThrow(`${key} is runner-owned`);
  });

  it('allows ordinary requirement metadata', () => {
    expect(PartialRequirementMetadataSchema.parse({
      product_area: 'billing',
    })).toEqual({ product_area: 'billing' });
  });
});
