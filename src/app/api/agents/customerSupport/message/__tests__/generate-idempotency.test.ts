const claimInboundCommand = jest.fn();
const bindInboundCommand = jest.fn();
const submitCommand = jest.fn();
const getCommandDbUuid = jest.fn();
const waitForCommandCompletion = jest.fn();
jest.mock('../inbound-command-idempotency', () => ({ claimInboundCommand: (...a: any[]) => claimInboundCommand(...a), bindInboundCommand: (...a: any[]) => bindInboundCommand(...a) }));
jest.mock('../command-runtime', () => ({ commandService: { submitCommand: (...a: any[]) => submitCommand(...a) },
  getCommandDbUuid: (...a: any[]) => getCommandDbUuid(...a), waitForCommandCompletion: (...a: any[]) => waitForCommandCompletion(...a) }));
jest.mock('@/lib/agentbase', () => ({ CommandFactory: { createCommand: (c: any) => c } }));
jest.mock('@/lib/services/customer-support-tool-catalog', () => ({ buildCustomerSupportTools: () => [] }));
jest.mock('../agent-data', () => ({ isValidUUID: (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) }));
jest.mock('../cors', () => ({ corsHeaders: () => ({}) }));
import { generateSupportReply } from '../generate';
const id = '11111111-1111-4111-8111-111111111111';
const input = { effectiveSiteId: id, effectiveAgentId: id, effectiveUserId: id, connectionId: 'connection', originMessageId: 'origin' };
beforeEach(() => {
  jest.clearAllMocks();
  claimInboundCommand.mockResolvedValue({ state: 'claimed', token: 'owner' });
  bindInboundCommand.mockResolvedValue(undefined);
  submitCommand.mockResolvedValue('alias');
  getCommandDbUuid.mockResolvedValue(id);
  waitForCommandCompletion.mockResolvedValue({ command: { id, status: 'completed', site_id: id, agent_id: id, user_id: id }, dbUuid: id, completed: true });
});
it('persists command identity before waiting for execution', async () => {
  expect(await generateSupportReply(input)).toMatchObject({ effectiveDbUuid: id });
  expect(submitCommand).toHaveBeenCalledTimes(1);
  expect(bindInboundCommand).toHaveBeenCalledWith({ siteId: id, connectionId: 'connection', originMessageId: 'origin' }, 'owner', id);
  expect(bindInboundCommand.mock.invocationCallOrder[0]).toBeLessThan(waitForCommandCompletion.mock.invocationCallOrder[0]);
});
it('retries poll recorded UUID without creating or binding a new command', async () => {
  claimInboundCommand.mockResolvedValue({ state: 'reuse', commandId: id });
  await generateSupportReply(input);
  expect(submitCommand).not.toHaveBeenCalled();
  expect(bindInboundCommand).not.toHaveBeenCalled();
  expect(waitForCommandCompletion).toHaveBeenCalledWith(id);
});
it('busy, store unavailable and missing scope fail before submission', async () => {
  claimInboundCommand.mockResolvedValue({ state: 'busy' });
  expect((await generateSupportReply(input) as Response).status).toBe(503);
  claimInboundCommand.mockRejectedValue(new Error('offline'));
  expect((await generateSupportReply(input) as Response).status).toBe(503);
  expect((await generateSupportReply({ ...input, connectionId: undefined }) as Response).status).toBe(503);
  expect(submitCommand).not.toHaveBeenCalled();
});
it('binding ambiguity blocks results rather than processing untracked execution', async () => {
  bindInboundCommand.mockRejectedValue(new Error('offline'));
  expect((await generateSupportReply(input) as Response).status).toBe(503);
  expect(waitForCommandCompletion).not.toHaveBeenCalled();
});
it('does not reuse a command from a different account or agent', async () => {
  claimInboundCommand.mockResolvedValue({ state: 'reuse', commandId: id });
  waitForCommandCompletion.mockResolvedValue({ command: { id, status: 'completed', site_id: 'other' }, dbUuid: id, completed: true });
  expect((await generateSupportReply(input) as Response).status).toBe(503);
  expect(submitCommand).not.toHaveBeenCalled();
});