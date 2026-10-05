import type { CommandEvidenceSignal, EvidenceRecord } from './requirement-evidence-types';

function normalizedCommand(command: string): string {
  // Script names and flags are case-sensitive. Do not strip arguments or suffixes.
  return command.trim().replace(/\s+/g, ' ');
}

function exactScript(command: string): string | undefined {
  return normalizedCommand(command)
    .match(/^(?:npm|pnpm|yarn|bun) (?:run )?([\w][\w:.-]*)$/)?.[1];
}

/** Legacy test receipts remain supported, but lint/build are never tests. */
export function isAutomatedTestCommand(command: string): boolean {
  const value = normalizedCommand(command);
  if (/[;&|`\n\r<>]|\$\(/.test(command)) return false;
  return /^(?:(?:npx|pnpm exec|bunx) )?(?:jest|vitest|mocha)(?: |$)/.test(value) ||
    /^(?:(?:npx|pnpm exec|bunx) )?playwright test(?: |$)/.test(value) ||
    /^(?:npm|pnpm|yarn|bun) (?:run )?test(?::[\w.-]+)?(?: |$)/.test(value);
}

export function commandMatchesReceipt(expected: string, observed: string): boolean {
  const command = normalizedCommand(expected);
  if (['lint', 'build', 'typecheck'].includes(command)) {
    return exactScript(observed) === command;
  }
  // The generic test claim deliberately retains legacy test-runner compatibility.
  if (command === 'test') return isAutomatedTestCommand(observed);
  return !!command && normalizedCommand(observed) === command;
}

export function commandEvidenceIsCurrent(
  signal: CommandEvidenceSignal,
  stepId: string | undefined,
  fingerprint: string | undefined,
): boolean {
  return !!stepId && !!fingerprint &&
    signal.step_id === stepId && signal.workspace_fingerprint === fingerprint &&
    signal.ran_after_changes === true &&
    typeof signal.command === 'string' && !!signal.command.trim() &&
    Number.isInteger(signal.exit_code) &&
    typeof signal.output_tail === 'string' &&
    typeof signal.captured_at === 'string' &&
    Number.isFinite(Date.parse(signal.captured_at));
}

export function commandEvidenceKey(signal: CommandEvidenceSignal): string {
  return JSON.stringify([
    signal.step_id, normalizedCommand(signal.command),
    signal.workspace_fingerprint, signal.criterion_id || '',
  ]);
}

/** Canonical current failures take precedence over any passing legacy receipt. */
export function matchCommandEvidence(
  command: string,
  evidence: EvidenceRecord,
  criterionId?: string,
): 'pass' | 'fail' | 'unknown' {
  const commands = (evidence.commands || []).filter((signal) =>
    commandEvidenceIsCurrent(signal, evidence.producer_step_id, evidence.workspace_fingerprint) &&
    (!signal.criterion_id || signal.criterion_id === criterionId) &&
    commandMatchesReceipt(command, signal.command));
  const tests = (evidence.tests || []).filter((test) =>
    isAutomatedTestCommand(test.command) &&
    commandMatchesReceipt(command, test.command) &&
    (!test.step_id || !evidence.producer_step_id || test.step_id === evidence.producer_step_id) &&
    (!test.workspace_fingerprint || !evidence.workspace_fingerprint ||
      test.workspace_fingerprint === evidence.workspace_fingerprint));
  const build = evidence.build && commandMatchesReceipt(command, evidence.build.command)
    ? evidence.build : undefined;
  if (commands.some((signal) => signal.exit_code !== 0) ||
    tests.some((test) => test.exit_code !== 0) ||
    (build && build.exit_code !== 0)) return 'fail';
  if (commands.some((signal) => signal.exit_code === 0) ||
    tests.some((test) => test.exit_code === 0 && test.ran_after_changes) ||
    build?.exit_code === 0) return 'pass';
  return 'unknown';
}