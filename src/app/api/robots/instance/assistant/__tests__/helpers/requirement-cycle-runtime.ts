import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { createRedactor } from '@/lib/harness/security';
import { requirementCycleFailure } from '../../requirement-cycle-failure';
import type { SessionStore } from '@/lib/harness/types';
import { admitAssistantRouting, withAssistantRouting } from '../../execution-routing';
import { getExecutionRouting } from '@/lib/services/ai/customer-routing';

/** Real lifecycle module; all external I/O is explicitly replaced for offline tests. */
export function cycleRuntime(input: { store: SessionStore; environment: 'cloud' | 'workspace'; execute: (...args: any[]) => Promise<any>;
  evaluateBudget?: () => Promise<boolean> }) {
  const finish = jest.fn(async () => {});
  const query = (table: string): any => ({
    select: () => query(table), eq: () => query(table), not: () => query(table),
    order: () => query(table), limit: () => query(table),
    single: async () => ({ data: table === 'requirements' ? { metadata: {}, type: 'task' } : {}, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
  });
  const runtime = loadRuntimeModule<typeof import('../../requirement-runtime')>(
    'src/app/api/robots/instance/assistant/requirement-runtime.ts', {
      '@/lib/database/supabase-client': { supabaseAdmin: { from: query } },
      '@/lib/harness/session': {},
      '@/lib/harness/store': { createSessionStore: () => input.store },
      './requirement-workspace': { executeRequirementAssistantWorkspace: input.execute },
      './requirement-cloud': { runCloudRequirementCycle: input.execute },
      '@/lib/services/requirement-environment': { resolveRequirementEnvironment: () => input.environment },
      '@/lib/harness/requirement-workspace-recovery': {},
      '@/lib/harness/requirement-scheduler': { assertRequirementRun: async () => {}, finishRequirementCycle: finish },
      '@/lib/harness/requirement-context': { loadRequirementContext: async () => ({ requirement: { title: 'Offline task' } }),
        formatRequirementContext: () => 'Offline context' },
      '@/lib/harness/requirement-tools': {},
      '@/lib/harness/requirement-profile': { buildRequirementProfile: async () => ({
        repository: { url: 'https://example.test/repo.git' }, branch: 'offline', profile: {},
      }) },
      '@/lib/harness/requirement-provisioning': {},
      '@/lib/harness/requirement-checkpoint-hook': { requirementCheckpointHook: () => undefined },
      '@/lib/harness/security': { createRedactor },
      '@/app/api/agents/tools/router/screen-access': { assertToolScreenAccess: async () => {} },
      './requirement-instance-log': { writeRequirementInstanceLog: async () => {} },
      './requirement-budget': { evaluateRequirementCycleBudget: input.evaluateBudget || (async () => false) },
      './requirement-cycle-failure': { requirementCycleFailure },
      './execution-routing': { admitAssistantRouting, withAssistantRouting },
      '@/lib/services/ai/customer-routing': { getExecutionRouting },
    });
  return { run: runtime.runRequirementCycle, finish };
}