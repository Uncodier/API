import type { CommandExecutionResult, DbCommand } from '../../models/types';
import { buildToolTurnContext } from './tool-loop-context';

export const MAX_TOOL_TURNS = 8;
export const DEFAULT_TOOL_LOOP_BUDGET_MS = 90_000;

export const TOOL_COMPLETION_TURN_INSTRUCTION = `
=== TOOL COMPLETION TURN ===
Previous tools in this command already ran. Their outputs are under "Tool Results and Information".
This command continues until you return [] or only possible_match. There is no background worker after the user-facing reply.
Return the NEXT tool(s) needed to finish the request, or [] if existing outputs already suffice or you must ask the user.
Do not repeat a tool that succeeded with the same arguments.
`;

export const TOOL_CORRECTION_TURN_INSTRUCTION = `
=== TOOL CORRECTION TURN ===
The last tool failed because its name or parameters were wrong. Call that tool again NOW with the exact available tool name and better arguments taken from the error (for example a corrected catalog_item_id). If the error says the tool does not exist, use name="reservations" with action="create" — never reservations.create. Do not reuse the same args. Do not return [] and do not write the user-facing reply yet. Return [] only if the error cannot be fixed without asking the user.
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

export function turnHadFailedTool(before: ToolFn[] = [], after: ToolFn[] = []): boolean {
  const beforeMap = new Map(before.map((fn) => [functionKey(fn), fn]));
  for (const fn of after) {
    if (String(fn?.status || '') !== 'failed') continue;
    const prev = beforeMap.get(functionKey(fn));
    if (!prev || prev.status !== 'failed' || resultSignature(prev) !== resultSignature(fn)) {
      return true;
    }
  }
  return false;
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
  getCommandById: (id: string, options?: { fresh?: boolean }) => Promise<DbCommand | null>;
};

export function getToolLoopBudgetMs(override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  const n = Number(process.env.TOOL_LOOP_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TOOL_LOOP_BUDGET_MS;
}

/**
 * Assistant-style completion loop for Agentbase tools.
 * Re-runs ToolEvaluator until the model returns [], only possible_match, MAX_TOOL_TURNS, or the time budget.
 * TargetProcessor still runs once after this loop.
 */
export async function runToolCompletionLoop(params: {
  toolEvaluator: ToolEvaluatorLike;
  command: DbCommand;
  commandService: CommandReader;
  now?: () => number;
  budgetMs?: number;
}): Promise<CommandExecutionResult> {
  const { toolEvaluator, commandService, command } = params;
  const originalTools = command.tools;
  const originalContext = command.context || '';
  const now = params.now || (() => Date.now());
  const budgetMs = getToolLoopBudgetMs(params.budgetMs);
  const startedAt = now();
  let current: DbCommand = command;
  let lastResult: CommandExecutionResult | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let previousTurnFailed = false;

  for (let turn = 1; turn <= MAX_TOOL_TURNS; turn++) {
    if (turn > 1 && now() - startedAt > budgetMs) {
      console.log(`[ToolCompletion] stop (stop_cap) budget ${budgetMs}ms exceeded after turn ${turn - 1} for command ${command.id}`);
      break;
    }

    if (turn > 1) {
      const fromDb = await commandService.getCommandById(command.id);
      const instruction = previousTurnFailed
        ? `${TOOL_COMPLETION_TURN_INSTRUCTION}\n${TOOL_CORRECTION_TURN_INSTRUCTION}`
        : TOOL_COMPLETION_TURN_INSTRUCTION;
      const functions = fromDb?.functions || current.functions || [];
      current = {
        ...current,
        ...(fromDb || {}),
        tools: originalTools,
        agent_background: command.agent_background || fromDb?.agent_background,
        context: buildToolTurnContext({
          originalContext,
          instruction,
          functions,
        }),
      };
      console.log(`[ToolCompletion] turn ${turn}/${MAX_TOOL_TURNS} for command ${command.id}${previousTurnFailed ? ' (correction)' : ''}`);
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

    const afterFunctions = current.functions || [];
    previousTurnFailed = turnHadFailedTool(beforeFunctions, afterFunctions);

    // A failed evaluator still continues if a tool failed — ask the model for better params.
    if (lastResult.status === 'failed' && !previousTurnFailed) {
      break;
    }

    const decision = classifyToolTurn(beforeFunctions, afterFunctions);
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
