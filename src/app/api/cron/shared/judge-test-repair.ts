import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import type { JudgeResult } from './archetype-judge-result';
import type { JudgeRepairRun } from './judge-repair-controller';

/** A host-generated diagnostic, not a prose instruction to unlock evidence tools. */
export function missingTestEvidenceResult(item: BacklogItem): JudgeResult {
  const reason = 'core item requires successful test evidence — prepare and run the repository test suite before claiming done';
  return {
    verdict: 'rejected', reason, failure_kind: 'evidence_gap',
    matched_acceptance: [], unmatched_acceptance: item.acceptance ?? [],
    acceptance_diagnostics: [{
      criterion_id: 'harness:successful-tests',
      criterion: 'Relevant automated tests pass after the latest changes',
      status: 'missing', claims: [],
      gaps: [{
        code: 'missing_test_evidence', class: 'evidence', message: reason,
        required: 'A completed test command with exit code 0 and fresh workspace-bound test evidence',
        suggested_action: 'Inspect package.json and the existing test setup. Use the repository test framework; add or repair relevant tests and fixtures only when needed. Run the tests, inspect failures, and correct them within the same backlog item. Do not ask the customer for permission. Do not weaken assertions, change acceptance, fabricate receipts, or alter production data. Use sandbox_run_tests for a bounded host-owned execution and fresh independent validation.',
      }],
    }],
  };
}

export function isTestRepairRun(run?: JudgeRepairRun): boolean {
  return !!run && run.failure_kind === 'evidence_gap' &&
    ['planned', 'in_progress', 'materialized'].includes(run.status) &&
    run.actions.length === 1 && run.actions[0].kind === 'repair_tests' &&
    run.actions[0].gap_code === 'missing_test_evidence';
}

export function isDirectTestCommand(command: unknown): command is string {
  if (typeof command !== 'string' || command.length > 2000 || /[;&|`$<>\r\n]/.test(command)) return false;
  if (/(?:^|\s)(?:--(?:help|version|list(?:-?tests)?|show-?config|pass-?with-?no-?tests|collect-?only|dry-?run)|-[hv])(?:=|\s|$)/i.test(command)) return false;
  // Existing direct runners only; no downloads, shell wrappers, or masked exits.
  return /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w.-]+)?|(?:jest|vitest|mocha)|playwright\s+test|node\s+--test|(?:node\s+)?(?:\.\/)?node_modules\/(?:\.bin\/(?:jest|vitest|mocha)|jest\/bin\/jest\.js))(?:\s|$)/i.test(command.trim());
}

/** Exit 0 from --help, an empty suite, or a no-op npm script is not test evidence. */
export function reportsExecutedTests(output: string): boolean {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  return /(?:^|\n)\s*(?:Tests?:?\s+[^\n]*\b[1-9]\d*\s+(?:passed|failed)|#\s*tests\s+[1-9]\d*\b|[1-9]\d*\s+(?:passing|passed|failing|failed)\b)/i.test(text);
}