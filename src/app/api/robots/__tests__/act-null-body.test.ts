import { jest } from '@jest/globals';
import { NextRequest } from 'next/server';

const from = jest.fn();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
const stubs = (...names: string[]) => Object.fromEntries(names.map(name => [name, jest.fn()]));
jest.unstable_mockModule('@/lib/services/robot-instance/robot-plan-service', () => stubs('addActivityToPlan'));
jest.unstable_mockModule('@/lib/helpers/robot-planning-core', () => stubs(
  'executeUnifiedRobotActivityPlanning', 'decidePlanAction', 'formatPlanSteps', 'addSessionSaveSteps', 'calculateEstimatedDuration'));
jest.unstable_mockModule('@/lib/helpers/agent-finder', () => stubs('findGrowthRobotAgent'));
jest.unstable_mockModule('@/lib/helpers/plan-lifecycle', () => stubs('completeInProgressPlans', 'resumePlan'));
jest.unstable_mockModule('@/lib/services/robot-instance/instance-provisioner', () => stubs('provisionScrapybaraInstance', 'needsProvisioning'));
jest.unstable_mockModule('@/lib/services/requirement-cron-reset', () => stubs('resetRequirementOnUserAction'));
jest.unstable_mockModule('@/app/api/robots/instance/assistant/user-message-log', () => stubs('insertUserActionLog'));
jest.unstable_mockModule('@/lib/custom-automation', () => stubs('AIAgentExecutor'));
jest.unstable_mockModule('scrapybara/anthropic', () => stubs('anthropic'));
jest.unstable_mockModule('@/lib/helpers/automation-auth', () => stubs('autoAuthenticateInstance'));
jest.unstable_mockModule('@/app/api/agents/tools/generateImage/assistantProtocol', () => stubs('generateImageToolScrapybara'));
jest.unstable_mockModule('@/app/api/agents/tools/generateVideo/assistantProtocol', () => stubs('generateVideoToolScrapybara'));
jest.unstable_mockModule('@/lib/services/robot-plan-execution', () => stubs(
  'ActSchema', 'AgentResponseSchema', 'updatePlanWithStepResult', 'markPlanAsStarted', 'getCurrentStep',
  'isPlanFullyCompleted', 'detectRequiredSessions', 'analyzeSessionsAvailability', 'formatSessionsContext',
  'formatSessionRequirementsContext', 'connectToInstance', 'validateInstanceStatus', 'verifyBrowserResponsive',
  'checkIfSubsequentPlan', 'setupTools', 'validateTools', 'createOnStepHandler', 'buildSystemPrompt',
  'buildUserPrompt', 'formatHistoricalLogs', 'estimateTokens', 'verifyInstanceRunning', 'findPlanForExecution',
  'detectStepStatus', 'buildSuccessResponse', 'handlePlanExecutionError', 'handleSpecialStates', 'saveExecutionSummary'));

let instanceAct: typeof import('../instance/act/route').POST;
let planAct: typeof import('../plan/act/route').POST;

beforeAll(async () => {
  ({ POST: instanceAct } = await import('../instance/act/route'));
  ({ POST: planAct } = await import('../plan/act/route'));
});

it.each(['instance/act', 'plan/act'])('returns 400 for JSON null at %s without reading the database', async path => {
  from.mockClear();
  const request = new NextRequest(`http://localhost/api/robots/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null',
  });
  const response = await (path === 'instance/act' ? instanceAct : planAct)(request);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Invalid request data' });
  expect(from).not.toHaveBeenCalled();
});