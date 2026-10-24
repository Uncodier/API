import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

it('the original cron entrypoint now owns the only requirement-agent dispatch', () => {
  const route = read('src/app/api/cron/requirements-apps/route.ts');
  const workflow = read('src/app/api/cron/requirements-apps/workflow.ts');
  const step = read('src/app/api/cron/requirements-apps/agent-step.ts');
  const runtime = read('src/app/api/robots/instance/assistant/requirement-runtime.ts');
  const workspace = read('src/app/api/robots/instance/assistant/requirement-workspace.ts');
  expect(route).toContain('start(runCronAppsWorkflow, [claim.run])');
  expect(workflow).toContain('executeRequirementCycle(run)');
  expect(step).toContain('@/app/api/robots/instance/assistant/requirement-runtime');
  expect(step).toContain('runRequirementCycle(run)');
  expect(runtime).toContain('executeRequirementAssistantWorkspace(');
  expect(workspace).toContain('runRequirementAssistantSlice(');
  expect(runtime).toContain('formatRequirementContext(context)');
  expect(runtime).toContain('createRequirementTools({ run })');
  for (const source of [route, workflow, step, runtime, workspace]) {
    expect(source).not.toContain('@/lib/harness/requirement-runtime');
    for (const gate of ['runSingleTurnGate', 'executeSingleTurnStep', 'runOrchestratorStep', 'scopeProductNoProgressCircuitStep', 'requestNoProgressStepAdjudicationStep',
      'provisionTrackingScriptStep', 'provisionPlatformKeyStep', 'verifyDatabaseMigrationsStep', 'validateDeliverablesStep', 'createFinalStatusStep']) expect(source).not.toContain(gate);
  }
  expect(existsSync(resolve(process.cwd(), 'src/app/api/harness/sessions/route.ts'))).toBe(false);
  expect(existsSync(resolve(process.cwd(), 'src/app/api/harness/sessions/workflow.ts'))).toBe(false);
  expect(JSON.parse(read('vercel.json')).crons).toContainEqual({ path: '/api/cron/requirements-apps', schedule: '* * * * *' });
});