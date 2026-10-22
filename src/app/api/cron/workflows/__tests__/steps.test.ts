import { executeScheduledWorkflowStep } from '../steps';
import { executeScheduledWorkflow } from '../workflow';
import { runWorkflowPlan } from '@/lib/services/workflow-robot/run-plan';

jest.mock('@/lib/services/workflow-robot/run-plan', () => ({ runWorkflowPlan: jest.fn() }));

it('does not automatically retry paid execution and awaits the claimed runner result', async () => {
  expect(executeScheduledWorkflowStep.maxRetries).toBe(0);
  jest.mocked(runWorkflowPlan).mockResolvedValue({ run_plan_id: 'plan', status: 'completed', steps_completed: 1 });
  expect(await executeScheduledWorkflow('plan')).toEqual({ run_plan_id: 'plan', status: 'completed', steps_completed: 1 });
  expect(runWorkflowPlan).toHaveBeenCalledTimes(1);
});