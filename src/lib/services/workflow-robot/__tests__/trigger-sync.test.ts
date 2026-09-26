// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's ES5 TS target.
import { jest } from '@jest/globals';
import type { WorkflowGraphNode } from '../types';

const from = jest.fn();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
const { syncWorkflowTriggersFromGraph } = await import('../materialize');

const trigger: WorkflowGraphNode = {
  id: 'trigger-1', type: 'wf-trigger', parent_node_id: null,
  instance_id: 'instance-1', site_id: 'site-1',
  settings: { enabled: true, trigger: { kind: 'channel_message', channel: 'web' } },
};
const step: WorkflowGraphNode = {
  id: 'step-1', type: 'wf-step', parent_node_id: 'trigger-1',
  instance_id: 'instance-1', site_id: 'site-1', prompt: { text: 'Analyze' },
};
const args = (nodes: WorkflowGraphNode[]) => ({
  instance_id: 'instance-1', site_id: 'site-1', template_plan_id: 'template-1', nodes,
});

function setup(existing: any[] = [], errorKind?: 'lookup' | 'insert' | 'update' | 'delete') {
  const read: any = {};
  read.select = jest.fn().mockReturnValue(read);
  read.eq = jest.fn().mockReturnValue(read);
  read.then = (resolve: (result: unknown) => any) => Promise.resolve({
    data: existing, error: errorKind === 'lookup' ? { message: 'lookup failed' } : null,
  }).then(resolve);

  const write: any = {};
  const insert: any = {};
  const insertSelect: any = {};
  const updated: any = {};
  const deleted: any = {};
  write.insert = jest.fn().mockReturnValue(insert);
  insert.select = jest.fn().mockReturnValue(insertSelect);
  insertSelect.single = jest.fn().mockResolvedValue({
    data: { id: 'new-trigger-1' }, error: errorKind === 'insert' ? { message: 'insert failed' } : null,
  });
  write.update = jest.fn().mockReturnValue(updated);
  updated.eq = jest.fn().mockResolvedValue({ error: errorKind === 'update' ? { message: 'update failed' } : null });
  write.delete = jest.fn().mockReturnValue(deleted);
  deleted.in = jest.fn().mockResolvedValue({ error: errorKind === 'delete' ? { message: 'delete failed' } : null });
  from.mockImplementation((table: string) => {
    if (table !== 'workflow_triggers') throw new Error('Unexpected table');
    return from.mock.calls.length === 1 ? read : write;
  });
  return { write };
}

beforeEach(() => jest.clearAllMocks());

it('disables channel triggers with no reachable executable steps', async () => {
  const { write } = setup();
  await syncWorkflowTriggersFromGraph(args([trigger]));
  expect(write.insert).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
});

it('keeps a channel trigger enabled when it has a descendant step', async () => {
  const { write } = setup();
  await syncWorkflowTriggersFromGraph(args([trigger, step]));
  expect(write.insert).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
});

it('disables channel triggers whose reachable steps require browser or sandbox', async () => {
  for (const stepSettings of [
    { requires_sandbox: true },
    { requires_browser: true },
    { browser_interaction_required: true },
  ]) {
    from.mockClear();
    const { write } = setup();
    await syncWorkflowTriggersFromGraph(args([trigger, {
      ...step, settings: { step: stepSettings },
    }]));
    expect(write.insert).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  }
});

it.each([
  ['lookup', [], [trigger]],
  ['insert', [], [trigger]],
  ['update', [{ id: 'old', node_id: 'trigger-1', kind: 'channel_message' }], [trigger]],
  ['delete', [{ id: 'old', node_id: 'trigger-1', kind: 'channel_message' }], []],
] as const)('does not report a successful sync when %s fails', async (kind, existing, nodes) => {
  setup([...existing], kind);
  await expect(syncWorkflowTriggersFromGraph(args([...nodes])))
    .rejects.toThrow(/Failed to .*workflow triggers?/);
});