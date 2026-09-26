import { relationContext, shouldRunWorkflowStep, workflowRelationPrompt } from '../relation-routing';

const parent = { id: 'step_1', order: 1, status: 'completed', metadata: { node_id: 'source' } };
const child = (relation_context?: string) => ({
  id: 'step_2', metadata: { node_id: 'target', parent_node_id: 'source', relation_context },
});

describe('workflow relation routing', () => {
  it('defaults to success and routes standard failure and always relations', () => {
    expect(relationContext(undefined)).toBe('on success');
    expect(shouldRunWorkflowStep(child(), [parent])).toBe(true);
    expect(shouldRunWorkflowStep(child('on fail'), [parent])).toBe(false);
    expect(shouldRunWorkflowStep(child('on error'), [{ ...parent, status: 'failed' }])).toBe(true);
    expect(shouldRunWorkflowStep(child(), [{ ...parent, status: 'failed' }])).toBe(false);
    expect(shouldRunWorkflowStep(child('always'), [{ ...parent, status: 'failed' }])).toBe(true);
    expect(shouldRunWorkflowStep(child('always'), [{ ...parent, status: 'cancelled' }])).toBe(false);
    expect(shouldRunWorkflowStep(child(), [{ ...parent, status: 'pending' }])).toBe(false);
    expect(shouldRunWorkflowStep(child('on failure'), [{ ...parent, status: 'failed' }])).toBe(true);
    expect(shouldRunWorkflowStep({ ...child('on fail'), metadata: { ...child('on fail').metadata, parent_node_id: 'trigger', parent_type: 'wf-trigger' } }, [])).toBe(false);
  });

  it('passes custom context to the agent to evaluate against parent outputs', () => {
    const step = child('when approved by customer');
    expect(shouldRunWorkflowStep(step, [parent])).toBe(true);
    expect(shouldRunWorkflowStep(step, [{ ...parent, status: 'failed' }])).toBe(true);
    expect(workflowRelationPrompt(step, [parent])).toContain('when approved by customer');
    expect(workflowRelationPrompt(step, [parent])).toContain('plan_result');
  });
});