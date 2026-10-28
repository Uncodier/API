import { guardRequirementAssistantTools, attachRequirementAssistantHost, readRequirementAssistantHost, attachAssistantStepResult, readAssistantStepResult } from '../requirement-host';

test('host authority cannot survive JSON serialization or be forged by context properties', () => {
  const context = {} as any;
  const host = { assertActive: jest.fn(), tools: [], boundary: {}, maxOutputTokens: 4096, refreshContext: jest.fn() } as any;
  attachRequirementAssistantHost(context, host);
  expect(readRequirementAssistantHost(context)).toBe(host);
  expect(readRequirementAssistantHost(JSON.parse(JSON.stringify(context)))).toBeUndefined();
  expect(readRequirementAssistantHost({ requirementHost: host } as any)).toBeUndefined();
});

test('step result authority is process local and not request metadata', () => {
  const context = {} as any;
  attachAssistantStepResult(context, () => ({ status: 'needs_input' }));
  expect(readAssistantStepResult(context)).toEqual({ status: 'needs_input' });
  expect(readAssistantStepResult(JSON.parse(JSON.stringify(context)))).toBeUndefined();
  expect(readAssistantStepResult({ stepResult: { status: 'completed' } } as any)).toBeUndefined();
});

test.each([
  ['activate_coding_agents', {}], ['update_repo', {}], ['instance_plan', { action: 'execute_step' }],
  ['requirement_status', { action: 'create' }], ['requirements', { action: 'update' }],
  ['requirement_backlog', { action: 'update' }],
])('runner cannot mutate competing authority via %s', async (name, args) => {
  const execute = jest.fn();
  const host = { assertActive: jest.fn(async () => {}) } as any;
  const [guarded] = guardRequirementAssistantTools(host, [{ name, description: '', parameters: {}, execute }]);
  expect(await guarded.execute(args)).toMatchObject({ success: false, executed: false });
  expect(execute).not.toHaveBeenCalled();
});

test('owned progress and inspection remain available, and ownership is rechecked', async () => {
  const execute = jest.fn(async () => 'receipt');
  const assertActive = jest.fn(async () => {});
  const [guarded] = guardRequirementAssistantTools({ assertActive } as any,
    [{ name: 'requirement_progress', description: '', parameters: {}, execute }]);
  expect(await guarded.execute({ target: 'message' })).toBe('receipt');
  assertActive.mockRejectedValueOnce(new Error('Owner changed'));
  await expect(guarded.execute({})).rejects.toThrow('Owner changed');
  expect(execute).toHaveBeenCalledTimes(1);
});