jest.mock('../CommandService', () => ({ CommandService: jest.fn() }));

import { CommandService } from '../CommandService';
import { updateFunctionStatuses } from '../../../agents/toolEvaluator/updater/functionStatusUpdater';
import { updateCommandContext } from '../../../agents/toolEvaluator/updater/contextUpdater';

describe('support tool result persistence', () => {
  let stored: any;
  beforeEach(() => {
    stored = { context: 'Original request', functions: [
      { id: 'old', name: 'scheduling', status: 'completed', result: { id: 'appointment-1' } },
      { id: 'new', name: 'scheduling', status: 'initialized' },
    ] };
    (CommandService as jest.Mock).mockImplementation(() => ({
      getCommandById: jest.fn(async () => stored),
      updateCommand: jest.fn(async (_id, update) => { stored = { ...stored, ...update }; }),
    }));
  });

  it.each([false, 0, '', null, []])('retains %p on the correct repeated call through both updaters', async output => {
    const results: any[] = [{ id: 'new', function_name: 'scheduling', status: 'success', output }];
    await updateFunctionStatuses('cmd-1', results);
    await updateCommandContext('cmd-1', results, []);
    expect(stored.functions[0].result).toEqual({ id: 'appointment-1' });
    expect(stored.functions[1]).toMatchObject({ status: 'completed', result: output });
    expect(stored.context).not.toContain('No output');
  });

  it('retains structured failed output in storage and the textual context', async () => {
    const output = { success: false, recovery: { auto_retry: false, suggested_dates: ['2026-10-29'] } };
    const results: any[] = [{ id: 'new', function_name: 'scheduling', status: 'error', error: 'Cannot confirm', output }];
    await updateFunctionStatuses('cmd-1', results);
    await updateCommandContext('cmd-1', results, []);
    expect(stored.functions[1]).toMatchObject({ status: 'failed', result: output });
    expect(stored.context).toContain(JSON.stringify(output));
    expect(stored.context).toContain('Cannot confirm');
  });

  it('appends a new call ID when only the earlier call is registered', async () => {
    stored.functions = [{ id: 'a', name: 'catalog_commerce', status: 'completed', arguments: '{"search":"A"}', result: { product: 'A' } }];
    const results: any[] = [{ id: 'b', function_name: 'catalog_commerce', arguments: '{"search":"B"}', status: 'success', output: { product: 'B' } }];
    await updateFunctionStatuses('cmd-1', results);
    await updateCommandContext('cmd-1', results, []);
    expect(stored.functions).toHaveLength(2);
    expect(stored.functions[0]).toMatchObject({ id: 'a', arguments: '{"search":"A"}', result: { product: 'A' } });
    expect(stored.functions[1]).toMatchObject({ id: 'b', arguments: '{"search":"B"}', result: { product: 'B' } });
  });

  it('correlates a single ID-less legacy entry and installs the actual ID and arguments', async () => {
    stored.functions = [{ name: 'scheduling', status: 'initialized', arguments: '{}' }];
    await updateFunctionStatuses('cmd-1', [{ id: 'new', function_name: 'scheduling', arguments: '{"action":"list"}', status: 'success', error: null, output: [] }]);
    expect(stored.functions).toHaveLength(1);
    expect(stored.functions[0]).toMatchObject({ id: 'new', arguments: '{"action":"list"}', result: [] });
  });
});