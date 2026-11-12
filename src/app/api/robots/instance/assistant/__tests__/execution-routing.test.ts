import { randomBytes, randomUUID } from 'node:crypto';
import { admitAssistantRouting, validateAssistantInferenceAdmission, withAssistantRouting } from '../execution-routing';
import { getExecutionRouting, type ExecutionRoutingReference } from '@/lib/services/ai/customer-routing';
import { getCustomerSelection, resolveCustomerCredential } from '@/lib/integrations/openrouter/store';
import { rolloutEnabled } from '@/lib/integrations/openrouter/types';
import { CreditService } from '@/lib/services/billing/CreditService';
import { parseRecoveryExecution } from '@/lib/services/robot-instance/assistant-recovery-schema';
import { prepareRecoveryStep } from '../assistant-recovery-steps';
import { initializeAssistantRecovery, loadAssistantRecovery } from '@/lib/services/robot-instance/assistant-recovery';
import { cycleRuntime } from './helpers/requirement-cycle-runtime';
import { MemorySessionStore } from '@/lib/harness/memory-store';
import { createSession } from '@/lib/harness/session';

jest.mock('@/lib/integrations/openrouter/types', () => ({ rolloutEnabled: jest.fn() }));
jest.mock('@/lib/integrations/openrouter/store', () => ({ getCustomerSelection: jest.fn(), resolveCustomerCredential: jest.fn() }));
jest.mock('@/lib/services/billing/CreditService', () => ({ CreditService: { validateCredits: jest.fn() } }));
jest.mock('@/lib/services/robot-instance/assistant-recovery', () => ({ initializeAssistantRecovery: jest.fn(), loadAssistantRecovery: jest.fn() }));

const siteId = randomUUID();
const ref: ExecutionRoutingReference = { payer: 'customer', siteId, connectionId: randomUUID(), policyVersion: 2, credentialVersion: 1 };
const scope = { siteId, instanceId: randomUUID(), userId: randomUUID(), userMessageLogId: randomUUID() };
const execution = { customTools: [], useSdkTools: false, executionRouting: ref };

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(getCustomerSelection).mockResolvedValue(ref as any);
  jest.mocked(resolveCustomerCredential).mockResolvedValue({ apiKey: randomBytes(24).toString('hex') } as any);
  jest.mocked(CreditService.validateCredits).mockResolvedValue(false);
});

it('closed rollout does not access new storage and preserves the platform admission gate', async () => {
  const pinned = await admitAssistantRouting(siteId);
  expect(pinned).toEqual({ payer: 'platform', siteId });
  expect(await validateAssistantInferenceAdmission(siteId, pinned)).toBe(false);
  expect(CreditService.validateCredits).toHaveBeenCalledWith(siteId, 0.001);
  expect(getCustomerSelection).not.toHaveBeenCalled();
  expect(resolveCustomerCredential).not.toHaveBeenCalled();
});

it('enabled admission without a connection remains platform and does not hide storage failures', async () => {
  jest.mocked(rolloutEnabled).mockReturnValue(true);
  jest.mocked(getCustomerSelection).mockResolvedValue(null);
  expect(await admitAssistantRouting(siteId)).toEqual({ payer: 'platform', siteId });
  jest.mocked(getCustomerSelection).mockRejectedValue(new Error('unavailable'));
  await expect(admitAssistantRouting(siteId)).rejects.toThrow('unavailable');
});

it('customer admission validates credentials without requiring platform inference balance', async () => {
  jest.mocked(rolloutEnabled).mockReturnValue(true);
  const pinned = await admitAssistantRouting(siteId);
  expect(pinned).toEqual(ref);
  expect(await validateAssistantInferenceAdmission(siteId, pinned)).toBe(true);
  expect(resolveCustomerCredential).toHaveBeenCalledWith(ref);
  expect(CreditService.validateCredits).not.toHaveBeenCalled();
});

it('restores a serialized pin independently for each step, never current selection', async () => {
  const persisted = parseRecoveryExecution(JSON.parse(JSON.stringify(execution)));
  for (let step = 0; step < 2; step++) {
    expect(getExecutionRouting()).toBeUndefined();
    await withAssistantRouting(siteId, persisted.executionRouting, async () => {
      expect(getExecutionRouting()).toEqual(ref);
    });
  }
  expect(resolveCustomerCredential).toHaveBeenCalledTimes(2);
  expect(getCustomerSelection).not.toHaveBeenCalled();
});

it('recovery rejects disconnect even with rollout off, without calling context/model or platform admission', async () => {
  jest.mocked(loadAssistantRecovery).mockResolvedValue({ execution } as any);
  jest.mocked(resolveCustomerCredential).mockRejectedValue(new Error('revoked'));
  expect(await prepareRecoveryStep(scope, { customTools: [], useSdkTools: false }, randomUUID())).toEqual({ ok: false });
  expect(initializeAssistantRecovery).not.toHaveBeenCalled();
  expect(getCustomerSelection).not.toHaveBeenCalled();
  expect(CreditService.validateCredits).not.toHaveBeenCalled();
});

it('snapshot pin wins over new options and survives recovery initialization', async () => {
  await prepareRecoveryStep(scope, execution);
  expect(initializeAssistantRecovery).toHaveBeenCalledWith(scope, execution);
  jest.mocked(loadAssistantRecovery).mockResolvedValue({ execution } as any);
  const resumed = await prepareRecoveryStep(scope, { customTools: [], useSdkTools: false,
    executionRouting: { payer: 'platform', siteId } }, randomUUID());
  expect(resumed).toMatchObject({ ok: true, snapshot: { execution } });
  expect(resolveCustomerCredential).toHaveBeenCalledWith(ref);
});

it('rejects credential payloads, malformed pins and cross-tenant restore', async () => {
  for (const invalid of [{ ...ref, apiKey: randomBytes(24).toString('hex') }, { ...ref, credentialVersion: 0 }, null]) {
    expect(() => parseRecoveryExecution({ ...execution, executionRouting: invalid })).toThrow();
  }
  await expect(withAssistantRouting(randomUUID(), ref, async () => null)).rejects.toThrow();
  expect(resolveCustomerCredential).not.toHaveBeenCalled();
});

it('legacy resumes retain platform routing even if today has a selected customer connection', async () => {
  jest.mocked(rolloutEnabled).mockReturnValue(true);
  await withAssistantRouting(siteId, undefined, async () => {
    expect(getExecutionRouting()).toEqual({ payer: 'platform', siteId });
  });
  expect(getCustomerSelection).not.toHaveBeenCalled();
});

it.each(['customer', 'platform'] as const)('cron restores the immutable %s session payer before cloud execution', async payer => {
  const run = { siteId, userId: randomUUID(), requirementId: randomUUID(), instanceId: randomUUID(),
    runId: randomUUID(), sessionId: randomUUID(), executionGeneration: 1 };
  const store = new MemorySessionStore();
  const session = createSession({ objective: 'Offline document', executionEnvironment: 'cloud' }, run.sessionId);
  session.request.requirementId = run.requirementId;
  if (payer === 'customer') session.request.executionRouting = ref;
  await store.create(session, { siteId, userId: run.userId });
  const execute = jest.fn(async () => {
    expect(getExecutionRouting()).toEqual(payer === 'customer' ? ref : { payer: 'platform', siteId });
    return { status: 'waiting', session };
  });
  const runtime = cycleRuntime({ store, environment: 'cloud', execute });
  expect(await runtime.run(run)).toMatchObject({ status: 'waiting' });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(getCustomerSelection).not.toHaveBeenCalled();
  if (payer === 'customer') {
    jest.mocked(resolveCustomerCredential).mockRejectedValue(new Error('revoked'));
    await runtime.run(run);
    expect(execute).toHaveBeenCalledTimes(1);
  }
});