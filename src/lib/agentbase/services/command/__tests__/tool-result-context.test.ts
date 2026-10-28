import { buildToolTurnContext, summarizeFunctions } from '../tool-loop-context';
import { runToolCompletionLoop } from '../tool-completion-loop';
import { prepareMessagesForTarget } from '../../../agents/targetEvaluator/formatters/target-message-formatter';
import type { DbCommand } from '../../../models/types';

const catalog = {
  id: 'lookup-1', name: 'catalog_commerce', status: 'completed',
  arguments: { action: 'list', search: 'química sanguínea de 20 elementos', limit: 20 },
  result: {
    success: true, count: 82, count_kind: 'candidate_window', result_kind: 'matched',
    degraded: false, has_more: false, search_id: 'search-1',
    items: Array.from({ length: 82 }, (_, i) => ({
      id: `item-${i}`, name: `QUIMICA ${i} ELEMENTOS`, target_sale_price: i,
      currency: 'MXN', status: 'active', availability_status: 'available',
      parent_id: null, image_url: 'unused-image',
      metadata: { constraints: ['requires fasting'] },
    })),
  },
};

function fixture(functions: any[] = []): DbCommand {
  return { id: 'cmd-1', task: 'create message', context: 'Current message: búscalo de nuevo',
    agent_background: 'Support instructions', tools: [], functions } as unknown as DbCommand;
}

describe('tool result context regression', () => {
  it('preserves all catalog candidates, prices and provenance while compacting redundant columns', () => {
    const context = buildToolTurnContext({ originalContext: 'Request', instruction: '', functions: [catalog] });
    const output = JSON.parse(context.split('Result: ')[1]);
    expect(output.items).toHaveLength(82);
    expect(output.items[81]).toMatchObject({ id: 'item-81', target_sale_price: 81, currency: 'MXN' });
    expect(output.items[0].target_sale_price).toBe(0);
    expect(output.items[0]).not.toHaveProperty('image_url');
    expect(output.items[0].metadata.constraints).toEqual(['requires fasting']);
    expect(output).toMatchObject({ count_kind: 'candidate_window', result_kind: 'matched', degraded: false });
    expect(context).toContain('química sanguínea de 20 elementos');
  });

  it('does not discard falsy, empty or nested non-catalog results', () => {
    for (const result of [false, 0, null, '', [], { slots: [{ id: 'slot-1' }] }]) {
      expect(summarizeFunctions([{ name: 'reservations', status: 'completed', result }]))
        .toContain(`Result: ${JSON.stringify(result)}`);
    }
  });

  it.each([false, true])('keeps output for the next evaluator and final target (budget cap=%s)', async capped => {
    const command = fixture();
    const executeCommand = jest.fn(async (current: DbCommand) => ({
      status: 'completed' as const, updatedCommand: { ...current, functions: [catalog] },
    }));
    const result = await runToolCompletionLoop({
      command, toolEvaluator: { executeCommand },
      commandService: { getCommandById: async () => fixture([catalog]) },
      now: () => capped && executeCommand.mock.calls.length ? 100 : 0, budgetMs: 50,
    });
    expect(executeCommand).toHaveBeenCalledTimes(capped ? 1 : 2);
    if (!capped) expect(executeCommand.mock.calls[1][0].context).toContain('"target_sale_price":81');
    const final = result.updatedCommand!;
    expect(final.context).toContain('"target_sale_price":81');
    expect(final.context).not.toContain('=== TOOL COMPLETION TURN ===');
    expect(prepareMessagesForTarget(final, 'Target instructions').map(m => m.content).join('\n'))
      .toContain('"currency":"MXN"');
  });

  it('supplies persisted results to targets even outside the completion loop, without duplicating them', () => {
    const command = fixture([catalog]);
    const messages = prepareMessagesForTarget(command, 'Target instructions');
    expect(messages[2].content).toContain('"target_sale_price":81');
    command.context = messages[2].content;
    expect(prepareMessagesForTarget(command, 'Target instructions')).toHaveLength(2);
  });
});