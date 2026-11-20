import type { CommandExecutionResult, DbCommand } from '../../../models/types';
import { formatToolEvaluatorPrompt } from '../../../prompts/tool-evaluator-prompt';
import { runToolCompletionLoop } from '../tool-completion-loop';

const tool = { name: 'support_connectors', parameters: { type: 'object' } };

it('only adds connector discovery guidance when the gateway is available', () => {
  expect(formatToolEvaluatorPrompt([tool])).toContain('search by intent first');
  expect(formatToolEvaluatorPrompt([])).not.toContain('search by intent first');
});

it('carries search and describe results through successive calls to the same registered tool', async () => {
  const name = 'connector:abc:READ';
  const receipts = [
    { args: { action: 'search', query: 'lookup' }, output: { tools: [{ name, description: 'Lookup' }] } },
    { args: { action: 'describe', name }, output: { name, version: 'v1', schema_hash: 'hash', parameters: { type: 'object' } } },
    { args: { action: 'call', name, version: 'v1', schema_hash: 'hash', arguments: {} }, output: { status: 'pending' } },
  ];
  const command = { id: 'cmd', tools: [tool], context: 'Lookup', functions: [] } as unknown as DbCommand;
  let rows: NonNullable<DbCommand['functions']> = [];
  let turn = 0;
  const executeCommand = async (current: DbCommand): Promise<CommandExecutionResult> => {
    expect(current.tools).toEqual([tool]);
    if (turn > 0) expect(current.context).toContain(JSON.stringify(receipts[turn - 1].output));
    const receipt = receipts[turn++];
    if (receipt) rows = [...rows, { id: `call-${turn}`, type: 'function', name: tool.name, status: 'completed',
      arguments: JSON.stringify(receipt.args), result: receipt.output }];
    return { status: 'completed', updatedCommand: { ...current, functions: rows } };
  };
  const result = await runToolCompletionLoop({ command, toolEvaluator: { executeCommand },
    commandService: { getCommandById: async () => ({ ...command, functions: rows }) } });
  expect(turn).toBe(4);
  expect(result.updatedCommand?.context).toContain('"status":"pending"');
});