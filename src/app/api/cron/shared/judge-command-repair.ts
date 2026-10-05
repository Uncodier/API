import type { JudgeRepairRun, RepairAction } from './judge-repair-controller';

const VALIDATION_SCRIPT = /^(?:lint|build|typecheck)(?::[a-z0-9_.-]+)?$/;

/** Only typed command gaps can grant this capability; never parse error prose. */
export function validationCommand(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined;
  const value = command.trim();
  if (VALIDATION_SCRIPT.test(value)) return `npm run ${value}`;
  return /^(?:npm|pnpm|yarn|bun) (?:run )?(?:lint|build|typecheck)(?::[a-z0-9_.-]+)?$/.test(value)
    ? value : undefined;
}

export function isCommandRepairAction(action?: RepairAction): boolean {
  return action?.kind === 'collect_evidence' && action.gap_code === 'missing_command_receipt' &&
    action.expected_receipt === 'command_execution' && !!validationCommand(action.command);
}

export function hasCommandRepair(run?: JudgeRepairRun): boolean {
  return !!run && ['evidence_gap', 'product_defect'].includes(run.failure_kind) &&
    ['planned', 'in_progress', 'materialized'].includes(run.status) &&
    run.actions.some(isCommandRepairAction);
}

export function pendingCommandRecovery(run?: JudgeRepairRun): boolean {
  return run?.status === 'in_progress' && (run.attempt_count || 0) < run.max_attempts &&
    run.actions.some(action => action.gap_code === 'missing_command_receipt' &&
      (isCommandRepairAction(action) || action.kind === 'repair_implementation'));
}

export function commandReceiptProvesAction(payload: unknown, command: string, seen = new Set<unknown>()): boolean {
  if (seen.has(payload)) return false;
  seen.add(payload);
  if (typeof payload === 'string') {
    try { return commandReceiptProvesAction(JSON.parse(payload), command, seen); } catch { return false; }
  }
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as Record<string, any>;
  if (value.receipt?.kind === 'command_execution') {
    return Array.isArray(value.receipt.commands) && value.receipt.commands.length === 1 &&
      value.receipt.commands[0]?.command === command;
  }
  return ['cleanedResult', 'result', 'output', 'content'].some(key =>
    value[key] != null && value[key] !== payload && commandReceiptProvesAction(value[key], command, seen));
}

/** Inspect the existing script, not its name: no downloads, shell wrappers or exit masking. */
export function isValidationScript(script: unknown, scriptName: string): script is string {
  if (typeof script !== 'string' || script.length > 2000) return false;
  const parts = script.trim().split(/\s+/);
  if (!parts.every(part => /^[a-zA-Z0-9_./:@=*-]+$/.test(part))) return false;
  if (parts.some(part => /^(?:--(?:fix.*|write|watch|help|version|list.*|show.*|dry-run|output-file|outDir|outFile|emitDeclarationOnly)|-[hvw])(?:=|$)/i.test(part))) return false;
  const kind = scriptName.split(':')[0];
  if (kind === 'lint') return /^(?:eslint|next\s+lint|prettier\s+--check)(?:\s|$)/.test(script.trim());
  if (kind === 'build') return /^next\s+build(?:\s|$)/.test(script.trim());
  return kind === 'typecheck' && /^tsc(?:\s|$)/.test(script.trim()) && parts.includes('--noEmit');
}