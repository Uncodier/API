import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { FatalError } from '@workflow/errors';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';
import { execution, recoveryDatabase, scope } from '@/lib/services/robot-instance/test-support/assistant-recovery-fixture';
import { RecoveryError } from '@/lib/services/robot-instance/assistant-recovery-schema';
import { getProviderRetryDecision } from '@/lib/services/robot-instance/assistant-failure-policy';

let db: ReturnType<typeof recoveryDatabase>;
let recovery: typeof import('@/lib/services/robot-instance/assistant-recovery');
let turn: typeof import('../assistant-turn');
let run: typeof import('../workflow').runAssistantWorkflow;
const core = jest.fn<(...args: any[]) => Promise<any>>();
const complete = jest.fn<(...args: any[]) => Promise<void>>();
const markFailed = jest.fn<(...args: any[]) => Promise<void>>();
const pause = jest.fn<(...args: any[]) => Promise<void>>();
const spawn = jest.fn<(...args: any[]) => Promise<boolean>>();

// Model the SDK's durable boundary: successful data survives serialization;
// a step_failed event reaches the workflow as FatalError, not RecoveryError.
const durableTurn = jest.fn<(...args: any[]) => Promise<any>>(async (context, messages) => {
  try {
    return JSON.parse(JSON.stringify(await turn.processAssistantTurn(context, messages)));
  } catch (error) {
    throw new FatalError(`Assistant step failed: ${(error as Error).message}`);
  } finally {
    // The database recovers before the workflow's ownership check.
    db.error = undefined;
  }
});

jest.unstable_mockModule('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: (table: string) => db.from(table) },
}));
jest.unstable_mockModule('../assistant-turn', () => ({ processAssistantTurn: durableTurn }));
jest.unstable_mockModule('../steps', () => ({ prepareAssistantContext: async () => ({
  instance: {}, initialMessage: 'Send the requested message', customTools: [], imageAssets: [],
  expectedResultsAmount: 1, systemPrompt: 'Original instructions', hasLinkedRequirement: false,
  executionOptions: { instance_id: scope.instanceId, site_id: scope.siteId, user_id: scope.userId },
}) }));
jest.unstable_mockModule('../plan-steps', () => ({
  getActiveInstancePlan: async () => null, getAssistantPlanOwnershipStep: jest.fn(),
  executePlanStep: jest.fn(), acquirePlanExecutionLockStep: jest.fn(), releasePlanExecutionLockStep: jest.fn(),
}));
jest.unstable_mockModule('../persist-and-fail-steps', () => ({
  persistUserMessageStep: jest.fn(), completeUserMessageStep: complete,
  pauseUserMessageStep: pause, markAssistantFailedStep: markFailed, pauseAssistantForCreditsStep: jest.fn(),
}));
jest.unstable_mockModule('../assistant-respawn-steps', () => ({ spawnSilentContinueStep: spawn }));

beforeAll(async () => {
  recovery = await import('@/lib/services/robot-instance/assistant-recovery');
  turn = loadRuntimeModule<typeof import('../assistant-turn')>(
    'src/app/api/robots/instance/assistant/assistant-turn.ts', {
      './assistant-turn-core': { processAssistantTurn: core },
      '@/lib/services/robot-instance/assistant-recovery': recovery,
      '@/lib/services/robot-instance/assistant-recovery-schema': { RecoveryError },
      '@/lib/services/robot-instance/assistant-failure-policy': { getProviderRetryDecision },
      './requirement-host': { readRequirementAssistantHost: () => undefined },
    },
  );
  ({ runAssistantWorkflow: run } = await import('../workflow'));
});
beforeEach(() => {
  jest.clearAllMocks(); db = recoveryDatabase();
  complete.mockImplementation(async (_id, generation) => {
    await recovery.assertAssistantRecoveryActive({ ...scope, generation });
    db.action().details.status = 'completed';
  });
  markFailed.mockImplementation(async () => { db.action().details.status = 'failed'; });
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected live request'));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('recovery failure across the durable assistant boundary', () => {
  it('preserves uncertain effects for delayed agent continuation instead of terminalizing the action', async () => {
    let effects = 0;
    const messages = [{ role: 'user', content: 'Send the requested message' }];
    core.mockImplementationOnce(async (context) => recovery.runAssistantRecoveryTool(
      context.recoveryScope, 'send', { recipient_id: 'recipient-1' }, async () => {
        effects++;
        db.error = { message: 'Temporary persistence outage after provider accepted' };
        return { accepted: true };
      },
    ));
    const options = { userMessageLogId: scope.userMessageLogId };
    const first = await run(scope.instanceId, messages[0].content, scope.siteId, scope.userId, [], false,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, options);

    expect(first).toMatchObject({ success: false, execution_status: 'paused' });
    expect(first.assistant_response).toBeUndefined();
    expect(markFailed).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(db.action().details.status).toBe('running');
    expect(db.snapshot()).toMatchObject({ inFlight: true, respawnCount: 0, messages,
      toolObservations: [{ name: 'send', outcome: 'unknown' }] });
    expect(effects).toBe(1);
    await expect(recovery.claimAssistantRecovery(scope, { allowStaleInFlight: true }))
      .rejects.toMatchObject({ code: 'in_flight' });

    const expired = new Date(Date.now() - 16 * 60_000).toISOString();
    db.snapshot().lastActivityAt = db.snapshot().inFlightSince = expired;
    const { resumeToken } = await recovery.claimAssistantRecovery(scope, { allowStaleInFlight: true });
    core.mockImplementationOnce(async (context, input) => {
      expect(context.systemPrompt).toContain('unknown');
      expect(context.systemPrompt).toContain('send');
      expect(input).toEqual(messages); // No invented successful tool receipt.
      return { isDone: true, text: 'Current delivery status checked; no duplicate send.', messages: input };
    });
    const resumed = await run(scope.instanceId, 'Continue', scope.siteId, scope.userId, [], false,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { ...options, silentContinue: true, resumeToken });
    expect(resumed.assistant_response).toContain('no duplicate send');
    expect(complete).toHaveBeenCalledWith(scope.userMessageLogId, 1);
    expect(db.action().details.status).toBe('completed');
    expect(effects).toBe(1);
    expect(durableTurn).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('demonstrates why throwing the original recovery error cannot preserve its identity', () => {
    const original = new RecoveryError('conflict');
    const durable = new FatalError(original.message);
    expect(durable.name).not.toBe(original.name);
    expect(durable).not.toBeInstanceOf(RecoveryError);
  });
});