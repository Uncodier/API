import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { isInsufficientCreditsError } from '@/lib/services/billing/credit-exhaustion-message';
import * as guards from '../orchestrator-plan-tool-guard';
import { evaluatePlanBacklogGate } from '@/lib/services/requirement-plan-backlog-gate';

describe('migration plan recovery orchestrator', () => {
  it.each([[true, false], [false, false], [true, true]])('enforces the host-selected tool boundary (recovery=%s, credits=%s)', async (migrationPlanRecovery, creditExhausted) => {
    const item = { id: 'base_setup', title: 'Base setup', phase_id: 'build', status: 'pending', attempts: 2 };
    const create = jest.fn(async () => ({ success: true, data: { id: 'plan' } }));
    const watchdog = jest.fn(async () => ({ escalated: [] }));
    const promote = jest.fn(async () => { item.status = 'in_progress'; return { promoted: item }; });
    const owner = jest.fn(async () => {});
    const refresh = jest.fn((tools: any[]) => tools);
    const available = ['sandbox_read_file', 'sandbox_run_command', 'sandbox_db_migrate', 'tools',
      'requirement_status', 'harness_inspect'].map(name => ({ name, execute: jest.fn() }));
    available.push({ name: 'instance_plan', execute: create });
    const model = jest.fn(async (_messages, _instance, options) => {
      if (creditExhausted) throw Object.assign(new Error('Not enough credits'), { name: 'InsufficientCreditsError' });
      const names = options.custom_tools.map((tool: any) => tool.name);
      if (migrationPlanRecovery) {
        expect(names).toEqual(['sandbox_read_file', 'harness_inspect', 'instance_plan']);
        expect(options.system_prompt).toContain('only source reads and instance_plan list/create');
      } else {
        expect(names).toContain('sandbox_db_migrate');
        expect(names).toContain('tools');
      }
      await options.custom_tools.find((tool: any) => tool.name === 'instance_plan').execute({
        action: 'create', title: 'Recover migration', steps: [{ title: 'Verify', instructions: 'Inspect', metadata: { backlog_item_id: item.id } }],
      });
      return { messages: [], isDone: true };
    });
    const runtime = loadRuntimeModule<typeof import('../cron-orchestrator-step')>(
      'src/app/api/cron/shared/cron-orchestrator-step.ts', {
        '@/lib/services/billing/credit-exhaustion-message': { isInsufficientCreditsError },
        '@/app/api/agents/tools/sandbox/assistantProtocol': { getSandboxTools: () => available },
        '@/lib/services/robot-instance/assistant-executor': { executeAssistantStep: model },
        '@/lib/services/sandbox-recovery': { connectOrRecreateRequirementSandbox: async () => ({ sandbox: {}, sandboxId: 'recovered' }) },
        '@/app/api/robots/instance/assistant/utils': { getAssistantTools: () => available },
        '@/lib/services/cron-audit-log': { logCronInfrastructureEvent: async () => {}, CronInfraEvent: {} },
        '@/lib/services/requirement-backlog': { escalateStaleInProgressItems: watchdog, ensureInProgressItem: promote },
        '@/lib/services/harness-diagnostics/tools': { refreshHarnessToolManifest: refresh },
        '@/lib/services/harness-diagnostics/guidance': { HARNESS_DIAGNOSTIC_GUIDANCE: 'Inspect first.' },
        './loop-detectors': { detectPlanningLoop: () => ({ triggered: false }) },
        './orchestrator-plan-tool-guard': guards,
        './cron-execution-ownership': { assertCronExecutionOwnership: owner, withCronExecutionOwnership: (tools: any[]) => tools },
        './workflow-db-steps': { getRequirementFullContextStep: async () => ({}) },
      },
    );
    const result = await runtime.runOrchestratorStep({ sandboxId: 'sandbox', reqId: 'req', requirementType: 'app',
      orchestratorPrompt: 'Plan', instanceId: 'instance', site_id: 'site', user_id: 'user', initialMessage: 'Recover plan',
      migrationPlanRecovery, executionOwnership: { requirementId: 'req', runId: 'run', executionGeneration: 1 },
    });
    if (creditExhausted) {
      expect(result).toMatchObject({ creditExhausted: true, createdPlan: false, turns: 1, effectiveSandboxId: 'recovered' });
      expect(model).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({ createdPlan: true, turns: 1, effectiveSandboxId: 'recovered' });
    expect(watchdog).toHaveBeenCalledTimes(migrationPlanRecovery ? 0 : 1);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(item.attempts).toBe(2);
    // The next worker's real backlog policy admits the recovered step only
    // because normal host WIP admission activated its existing pending item.
    const step = (create.mock.calls as unknown as Array<[any]>)[0][0].steps[0];
    expect(evaluatePlanBacklogGate(step, [item as any])).toEqual({ runnable: true, itemId: item.id });
    expect(owner).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith(expect.any(Array), 'coordinator');
    if (migrationPlanRecovery) expect(create).toHaveBeenCalledWith(expect.objectContaining({
      requirement_id: 'req', steps: [expect.objectContaining({ requires_sandbox: true })],
    }));
  });
});