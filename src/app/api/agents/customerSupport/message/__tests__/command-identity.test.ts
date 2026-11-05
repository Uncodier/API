const getCommandById = jest.fn();
jest.mock('@/lib/agentbase', () => ({ ProcessorInitializer: { getInstance: () => ({
  initialize: jest.fn(), getCommandService: () => ({ getCommandById }),
}) } }));
jest.mock('../agent-data', () => ({ isValidUUID: (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) }));
import { getCommandDbUuid } from '../command-runtime';
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => getCommandById.mockReset());
it('accepts an exact database UUID without guessing', async () => {
  expect(await getCommandDbUuid(id)).toBe(id);
  expect(getCommandById).not.toHaveBeenCalled();
});
it('resolves only explicit alias metadata', async () => {
  getCommandById.mockResolvedValue({ metadata: { dbUuid: id } });
  expect(await getCommandDbUuid('legacy-alias')).toBe(id);
  expect(getCommandById).toHaveBeenCalledWith('legacy-alias', { fresh: true });
});
it('does not infer identity from matching task/user/status or malformed metadata', async () => {
  getCommandById.mockResolvedValue({ task: 'create message', user_id: id, status: 'completed', metadata: { dbUuid: 'bad' } });
  expect(await getCommandDbUuid('legacy-alias')).toBeNull();
});
it('fails closed on lookup failures', async () => {
  getCommandById.mockRejectedValue(new Error('offline'));
  expect(await getCommandDbUuid('legacy-alias')).toBeNull();
});