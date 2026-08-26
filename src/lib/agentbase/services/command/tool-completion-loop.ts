import type { CommandExecutionResult, DbCommand } from '../../models/types';

export const MAX_TOOL_TURNS = 8;

export const TOOL_COMPLETION_TURN_INSTRUCTION = `
=== TOOL COMPLETION TURN ===
Previous tools in this command already ran. Their outputs are under "Tool Results and Information".
This command continues until you return [] or only possible_match. There is no background worker after the user-facing reply.
Return the NEXT tool(s) needed to finish the request, or [] if existing outputs already suffice or you must ask the user.
Do not repeat a tool that succeeded with the same arguments.
`;

export type ToolCompletionDecision = 'continue' | 'stop_empty' | 'stop_possible_match' | 'stop_cap';

type ToolFn = {
  id?: string;
  name?: string;
  status?: string;
  arguments?: unknown;
  result?: unknown;
};

function functionKey(fn: ToolFn): string {
  const name = String(fn?.name || fn?.id || '');
  let args = fn?.arguments ?? '{}';
  if (typeof args !== 'string') {
    try {
      args = JSON.stringify(args);
    } catch {
      args = String(args);
    }
  }
  return `${name}:${args}`;
}

function resultSignature(fn: ToolFn): string {
  if (fn?.result == null) return '';
  if (typeof fn.result === 'string') return fn.result;
  try {
    return JSON.stringify(fn.result);
  } catch {
    return String(fn.result);
  }
}

export function classifyToolTurn(before: ToolFn[] = [], after: ToolFn[] = []): ToolCompletionDecision {
  const beforeMap = new Map(before.map((fn) => [functionKey(fn), fn]));
  let executedThisTurn = false;
  let possibleMatchThisTurn = false;

  for (const fn of after) {
    const status = String(fn?.status || '');
    const prev = beforeMap.get(functionKey(fn));
    const isNew = !prev;

    if (status === 'completed' || status === 'failed') {
      if (isNew || prev?.status !== status || resultSignature(prev) !== resultSignature(fn)) {
        executedThisTurn = true;
      }
    } else if (status === 'possible_match' && isNew) {
      possibleMatchThisTurn = true;
    }
  }

  if (executedThisTurn) return 'continue';
  if (possibleMatchThisTurn) return 'stop_possible_match';
  return 'stop_empty';
}

export function shouldContinueToolCompletion(params: {
  turn: number;
  maxTurns: number;
  decision: ToolCompletionDecision;
}): boolean {
  if (params.turn >= params.maxTurns) return false;
  return params.decision === 'continue';
}

type ToolEvaluatorLike = {
  executeCommand: (command: DbCommand) => Promise<CommandExecutionResult>;
};

type CommandReader = {
  getCommandById: (id: string) => Promise<DbCommand | null>;
};

/**
 * Assistant-style completion loop for Agentbase tools.
 * Re-runs ToolEvaluator until the model returns [], only possible_match, or MAX_TOOL_TURNS.
 * TargetProcessor still runs once after this loop.
 */
export async function runToolCompletionLoop(params: {
  toolEvaluator: ToolEvaluatorLike;
  command: DbCommand;
  commandService: CommandReader;
}): Promise<CommandExecutionResult> {
  const { toolEvaluator, commandService, command } = params;
  const originalTools = command.tools;
  let current: DbCommand = command;
  let lastResult: CommandExecutionResult | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  for (let turn = 1; turn <= MAX_TOOL_TURNS; turn++) {
    if (turn > 1) {
      const fromDb = await commandService.getCommandById(command.id);
      current = {
        ...current,
        ...(fromDb || {}),
        tools: originalTools,
        agent_background: command.agent_background || fromDb?.agent_background,
        context: `${fromDb?.context || current.context || ''}\n${TOOL_COMPLETION_TURN_INSTRUCTION}`,
      };
      console.log(`[ToolCompletion] turn ${turn}/${MAX_TOOL_TURNS} for command ${command.id}`);
    } else {
      console.log(`[ToolCompletion] turn ${turn}/${MAX_TOOL_TURNS} for command ${command.id}`);
    }

    const beforeFunctions = [...(current.functions || [])];
    current.tools = originalTools;
    lastResult = await toolEvaluator.executeCommand(current);
    current = lastResult.updatedCommand || current;
    inputTokens += lastResult.inputTokens || 0;
    outputTokens += lastResult.outputTokens || 0;

    const fromDb = await commandService.getCommandById(command.id);
    if (fromDb?.functions?.length) {
      current.functions = fromDb.functions;
    }

    if (lastResult.status === 'failed') {
      break;
    }

    const decision = classifyToolTurn(beforeFunctions, current.functions || []);
    if (decision !== 'continue') {
      console.log(`[ToolCompletion] stop (${decision}) after turn ${turn} for command ${command.id}`);
    }

    if (!shouldContinueToolCompletion({ turn, maxTurns: MAX_TOOL_TURNS, decision })) {
      break;
    }
  }

  if (!lastResult) {
    return { status: 'failed', error: 'Tool evaluator did not run', updatedCommand: command };
  }

  return {
    ...lastResult,
    inputTokens,
    outputTokens,
    updatedCommand: {
      ...(lastResult.updatedCommand || current),
      functions: current.functions,
      tools: originalTools,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}
