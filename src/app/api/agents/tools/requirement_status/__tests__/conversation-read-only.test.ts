import { randomUUID } from 'node:crypto';

const create = jest.fn(), list = jest.fn();
jest.mock('@/lib/tools/requirement-status-core', () => ({
  createRequirementStatusCore: create, listRequirementStatusCore: list,
}));
import { requirementStatusTool } from '../assistantProtocol';

const site = randomUUID(), source = randomUUID(), runner = randomUUID(), requirement = randomUUID();
beforeEach(() => {
  jest.clearAllMocks();
  list.mockResolvedValue({ success: true, data: [] });
  create.mockResolvedValue({ success: true });
});

it('advertises only reads without contradictory mandatory status instructions', () => {
  const tool = requirementStatusTool(site, source, { readOnly: true });
  expect(tool.parameters.properties.action.enum).toEqual(['list']);
  expect(tool.description).not.toContain('MUST add a status');
  expect(tool.description).toContain('already persists');
  expect(tool.parameters.properties).not.toHaveProperty('stage');
  expect(tool.parameters.properties).not.toHaveProperty('message');
});

it.each([undefined, 'list' as const])('defaults conversation reads to all requirement history, not the requesting instance: %s', async action => {
  await requirementStatusTool(site, source, { readOnly: true }).execute({ action, requirement_id: requirement });
  expect(list).toHaveBeenCalledWith({ requirement_id: requirement, instance_id: undefined });
  expect(create).not.toHaveBeenCalled();
});

it('permits an explicit runner filter for inspection', async () => {
  await requirementStatusTool(site, source, { readOnly: true }).execute({ action: 'list', requirement_id: requirement, instance_id: runner });
  expect(list).toHaveBeenCalledWith({ requirement_id: requirement, instance_id: runner });
});

it('rejects the reported queued status call without persistence or command replay', async () => {
  await expect(requirementStatusTool(site, source, { readOnly: true }).execute({
    action: 'create', requirement_id: requirement, instance_id: source,
    stage: 'queued', message: 'execution_started=false; ranking pending',
  })).rejects.toThrow('receipt is already persisted');
  expect(create).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
});

it('preserves runner status creation and its historical default', async () => {
  await requirementStatusTool(site, runner).execute({ requirement_id: requirement, stage: 'in-progress', message: 'Actual runner progress' });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ requirement_id: requirement, instance_id: runner, site_id: site }));
});