import {
  findAssistantManagedPlan,
  findAssistantManagedPlanForRequirement,
  isRespawnManagedPlan,
  isWorkflowManagedPlan,
} from '../plan-ownership';

describe('workflow plan ownership', () => {
  it('identifies workflow templates and materialized workflow runs', () => {
    expect(isWorkflowManagedPlan({ metadata: { workflow_template: true } })).toBe(true);
    expect(isWorkflowManagedPlan({ metadata: { workflow_run: true } })).toBe(true);
    expect(isWorkflowManagedPlan({ metadata: { workflow_run: false } })).toBe(false);
    expect(isWorkflowManagedPlan({ metadata: null })).toBe(false);
  });

  it('prevents respawns for workflow and requirement-managed plans', () => {
    expect(isRespawnManagedPlan({
      metadata: { requirement_id: 'requirement-1' },
    })).toBe(true);
    expect(isRespawnManagedPlan({
      metadata: { workflow_run: true },
    })).toBe(true);
    expect(isRespawnManagedPlan({
      metadata: { source: 'assistant' },
    })).toBe(false);
  });

  it('keeps generic assistants away from workflow-managed plans', () => {
    const plans = [
      { id: 'workflow-run', metadata: { workflow_run: true } },
      { id: 'workflow-template', metadata: { workflow_template: true } },
      { id: 'assistant-plan', metadata: { source: 'assistant' } },
    ];

    expect(findAssistantManagedPlan(plans)?.id).toBe('assistant-plan');
  });

  it('selects the assistant plan owned by the requested requirement', () => {
    const plans = [
      {
        id: 'other-requirement',
        metadata: { requirement_id: 'req-2' },
      },
      {
        id: 'workflow-run',
        metadata: { requirement_id: 'req-1', workflow_run: true },
      },
      {
        id: 'matching-plan',
        metadata: { requirement_id: 'req-1' },
      },
    ];

    expect(
      findAssistantManagedPlanForRequirement(plans, 'req-1')?.id,
    ).toBe('matching-plan');
  });

  it('falls back to a legacy unscoped assistant plan', () => {
    const plans = [
      { id: 'other-requirement', metadata: { requirement_id: 'req-2' } },
      { id: 'legacy-plan', metadata: { source: 'assistant' } },
    ];

    expect(
      findAssistantManagedPlanForRequirement(plans, 'req-1')?.id,
    ).toBe('legacy-plan');
  });
});
