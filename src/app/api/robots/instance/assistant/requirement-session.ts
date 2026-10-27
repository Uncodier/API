import { prepareAssistantContext } from './assistant-context';
import { processAssistantTurn } from './assistant-turn-core';
import { attachRequirementAssistantHost } from './requirement-host';
import { createRequirementExecutionBoundary } from './requirement-execution-boundary';
import { writeRequirementInstanceLog } from './requirement-instance-log';
import { createRequirementAssistantBilling } from './requirement-billing';
import type { RequirementRun } from '@/lib/harness/requirement-types';
import type { ArtifactStore, HarnessSession, HarnessTool, SessionStore, Workspace } from '@/lib/harness/types';

export interface RequirementAssistantSliceInput {
  session: HarnessSession;
  store: SessionStore;
  owner: string;
  run: RequirementRun;
  workspace: Workspace;
  tools: HarnessTool[];
  artifacts: ArtifactStore;
  redact: (value: string) => string;
  signal: AbortSignal;
  assertExecution: () => Promise<void>;
  context?: string;
  getContext?: () => Promise<string>;
  sliceMs?: number;
  onCheckpoint?: (context: { owner: string; assertActive: () => Promise<void>; signal: AbortSignal }) => Promise<void>;
}

/** Continuation scheduler, not an agent engine: every turn uses the canonical assistant core. */
export async function runRequirementAssistantSlice(input: RequirementAssistantSliceInput): Promise<HarnessSession> {
  const { run } = input;
  await input.assertExecution();
  if (input.session.id !== run.sessionId || input.session.request.requirementId !== run.requirementId) {
    throw new Error('Assistant requirement checkpoint scope mismatch');
  }
  const session = { ...input.session, workspace: input.workspace.ref };
  const adapter = createRequirementExecutionBoundary({
    session, store: input.store, owner: input.owner, run, artifacts: input.artifacts,
    redact: input.redact, assertActive: input.assertExecution, signal: input.signal, tools: input.tools,
    writeLog: event => writeRequirementInstanceLog(run, event, input.redact),
    onCheckpoint: input.onCheckpoint,
  });
  await adapter.initialize();
  if (adapter.getSession().status !== 'running') return adapter.getSession();
  adapter.boundary.billing = createRequirementAssistantBilling(run, input.assertExecution);
  const tools = input.tools.map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters,
    execute: (args: any) => adapter.executeHarnessTool(tool.name, args),
  }));
  const context = await prepareAssistantContext(run.instanceId, session.request.objective,
    run.siteId, run.userId, [], false, undefined, undefined, undefined, undefined,
    1, undefined, undefined, undefined, undefined,
    { requirementId: run.requirementId, assertActive: input.assertExecution });
  attachRequirementAssistantHost(context, {
    assertActive: input.assertExecution, boundary: adapter.boundary,
    tools: [...tools, ...adapter.controlTools],
    refreshContext: async () => input.redact([
      input.context || '',
      `Owned workspace: ${input.workspace.ref.root}. Its existence does not require repository changes or deployment.`,
      await input.getContext?.() || '',
    ].filter(Boolean).join('\n\n')),
  });
  const started = Date.now();
  while (adapter.getSession().status === 'running' && Date.now() - started < (input.sliceMs ?? 60000)) {
    await input.assertExecution();
    const result = await processAssistantTurn(context, adapter.getMessages());
    if (result.creditExhausted) {
      const error = new Error('Assistant requirement billing requires reconciliation');
      error.name = 'OpenRouterBillingError';
      throw error;
    }
  }
  await adapter.finish();
  return adapter.getSession();
}