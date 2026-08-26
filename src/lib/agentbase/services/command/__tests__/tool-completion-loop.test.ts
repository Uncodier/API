import {
  classifyToolTurn,
  MAX_TOOL_TURNS,
  runToolCompletionLoop,
  shouldContinueToolCompletion,
  TOOL_COMPLETION_TURN_INSTRUCTION,
  TOOL_CORRECTION_TURN_INSTRUCTION,
} from '../tool-completion-loop';
import type { CommandExecutionResult, DbCommand } from '../../../models/types';

function commandFixture(functions: any[] = []): DbCommand {
  return {
    id: 'cmd-1',
    task: 'create message',
    status: 'running',
    user_id: 'user-1',
    created_at: '',
    updated_at: '',
    tools: [{ type: 'function', function: { name: 'calendars', execute: () => {} } }],
    agent_background: 'cs',
    context: 'Se pudo?',
    functions,
  } as unknown as DbCommand;
}

describe('tool-completion-loop', () => {
  it('caps at 8 turns', () => {
    expect(MAX_TOOL_TURNS).toBe(8);
    expect(
      shouldContinueToolCompletion({ turn: 8, maxTurns: 8, decision: 'continue' })
    ).toBe(false);
  });

  it('continues after an executed tool and stops on empty or possible_match', () => {
    expect(
      classifyToolTurn([], [{ name: 'calendars', status: 'completed', arguments: '{"action":"list"}' }])
    ).toBe('continue');

    expect(
      classifyToolTurn(
        [{ name: 'calendars', status: 'completed', arguments: '{"action":"list"}' }],
        [{ name: 'calendars', status: 'completed', arguments: '{"action":"list"}' }]
      )
    ).toBe('stop_empty');

    expect(
      classifyToolTurn([], [{ name: 'scheduling', status: 'possible_match', arguments: '{}' }])
    ).toBe('stop_possible_match');
  });

  it('tells later turns this is a completion loop', () => {
    expect(TOOL_COMPLETION_TURN_INSTRUCTION).toContain('TOOL COMPLETION TURN');
    expect(TOOL_COMPLETION_TURN_INSTRUCTION).toContain('no background worker');
  });

  it('re-runs after calendars.list and stops when the next turn returns []', async () => {
    const calendarsFn = {
      name: 'calendars',
      status: 'completed',
      arguments: '{"action":"list","query":"Emmanuel"}',
      result: { reservable_services: [{ id: 'svc-1' }] },
    };

    let storedFunctions: any[] = [];
    const command = commandFixture();
    const executeCommand = jest.fn(async (current: DbCommand): Promise<CommandExecutionResult> => {
      if (executeCommand.mock.calls.length === 1) {
        storedFunctions = [calendarsFn];
        return {
          status: 'completed',
          updatedCommand: { ...current, functions: storedFunctions },
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return {
        status: 'completed',
        updatedCommand: { ...current, functions: storedFunctions },
        inputTokens: 4,
        outputTokens: 2,
      };
    });

    const result = await runToolCompletionLoop({
      toolEvaluator: { executeCommand },
      command,
      commandService: {
        getCommandById: async () => ({ ...command, functions: storedFunctions }),
      },
    });

    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(executeCommand.mock.calls[0][0].context).not.toContain('TOOL COMPLETION TURN');
    expect(executeCommand.mock.calls[1][0].context).toContain('TOOL COMPLETION TURN');
    expect(result.updatedCommand?.functions).toEqual([calendarsFn]);
  });

  it('stops immediately on possible_match so TargetProcessor can ask', async () => {
    const possibleMatch = {
      name: 'scheduling',
      status: 'possible_match',
      arguments: '{}',
    };
    let storedFunctions: any[] = [];
    const executeCommand = jest.fn(async (current: DbCommand): Promise<CommandExecutionResult> => {
      storedFunctions = [possibleMatch];
      return { status: 'completed', updatedCommand: { ...current, functions: storedFunctions } };
    });

    await runToolCompletionLoop({
      toolEvaluator: { executeCommand },
      command: commandFixture(),
      commandService: {
        getCommandById: async () => commandFixture(storedFunctions),
      },
    });

    expect(executeCommand).toHaveBeenCalledTimes(1);
  });

  it('asks the next turn to correct params after a failed tool', async () => {
    const failedFn = {
      name: 'reservations',
      status: 'failed',
      arguments: '{"action":"get_available_slots","catalog_item_id":"folio"}',
      result: { error: 'catalog_item_id is a reservation id; use catalog_item_id=item-1' },
    };
    let storedFunctions: any[] = [];
    const executeCommand = jest.fn(async (current: DbCommand): Promise<CommandExecutionResult> => {
      if (executeCommand.mock.calls.length === 1) {
        storedFunctions = [failedFn];
        return { status: 'completed', updatedCommand: { ...current, functions: storedFunctions } };
      }
      return { status: 'completed', updatedCommand: { ...current, functions: storedFunctions } };
    });

    await runToolCompletionLoop({
      toolEvaluator: { executeCommand },
      command: commandFixture(),
      commandService: {
        getCommandById: async () => commandFixture(storedFunctions),
      },
    });

    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(executeCommand.mock.calls[1][0].context).toContain('TOOL CORRECTION TURN');
    expect(executeCommand.mock.calls[1][0].context).toContain('better arguments taken from the error');
    expect(TOOL_CORRECTION_TURN_INSTRUCTION).toContain('Do not return []');
    expect(TOOL_CORRECTION_TURN_INSTRUCTION).toContain('never reservations.create');
  });

  it('still asks the model for better params if the evaluator status is failed but a tool failed', async () => {
    const failedFn = {
      name: 'reservations',
      status: 'failed',
      arguments: '{"action":"get_available_slots","catalog_item_id":"folio"}',
      result: { error: 'catalog_item_id is a reservation id; use catalog_item_id=item-1' },
    };
    let storedFunctions: any[] = [];
    const executeCommand = jest.fn(async (current: DbCommand): Promise<CommandExecutionResult> => {
      if (executeCommand.mock.calls.length === 1) {
        storedFunctions = [failedFn];
        return { status: 'failed', error: 'tool failed', updatedCommand: { ...current, functions: storedFunctions } };
      }
      return { status: 'completed', updatedCommand: { ...current, functions: storedFunctions } };
    });

    await runToolCompletionLoop({
      toolEvaluator: { executeCommand },
      command: commandFixture(),
      commandService: {
        getCommandById: async () => commandFixture(storedFunctions),
      },
    });

    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(executeCommand.mock.calls[1][0].context).toContain('TOOL CORRECTION TURN');
  });

  it('does not loop forever when every turn executes a new tool', async () => {
    let storedFunctions: any[] = [];
    const executeCommand = jest.fn(async (current: DbCommand): Promise<CommandExecutionResult> => {
      storedFunctions = [
        ...storedFunctions,
        {
          name: `tool_${storedFunctions.length}`,
          status: 'completed',
          arguments: `{"n":${storedFunctions.length}}`,
          result: storedFunctions.length,
        },
      ];
      return { status: 'completed', updatedCommand: { ...current, functions: storedFunctions } };
    });

    await runToolCompletionLoop({
      toolEvaluator: { executeCommand },
      command: commandFixture(),
      commandService: {
        getCommandById: async () => commandFixture(storedFunctions),
      },
    });

    expect(executeCommand).toHaveBeenCalledTimes(MAX_TOOL_TURNS);
  });
});
