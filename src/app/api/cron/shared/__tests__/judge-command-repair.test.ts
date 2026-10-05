import { hasCommandRepair, isValidationScript, pendingCommandRecovery, validationCommand } from '../judge-command-repair';
import { extractRepairActionReceipts, planJudgeRepair, recordJudgeRepairAttempt, startJudgeRepairRun } from '../judge-repair-controller';
import { restrictToolsForEvidenceCollection } from '../single-turn-helpers';
import { buildSingleTurnSystemPrompt } from '../single-turn-prompt';
import { formatJudgeRepairFeedback } from '../judge-verification-policy';
import type { JudgeResult } from '../archetype-judge-result';

jest.mock('@/lib/services/sandbox-service', () => ({ SandboxService: { WORK_DIR: '/vercel/sandbox' } }));
const judge: JudgeResult = { verdict: 'rejected', reason: 'lint receipt missing', failure_kind: 'evidence_gap',
  matched_acceptance: [], unmatched_acceptance: ['npm run lint exits 0'], acceptance_diagnostics: [{
    criterion_id: 'lint', criterion: 'npm run lint exits 0', status: 'missing', claims: [{ kind: 'command', command: 'lint' }],
    gaps: [{ code: 'missing_command_receipt', class: 'evidence', message: 'Missing command', required: 'lint', suggested_action: 'Run it' }],
  }] };
const newRun = () => startJudgeRepairRun(planJudgeRepair({ judge, repairRunId: 'repair' })!);
const turn = (toolName: string, result: unknown) => ({ steps: [{ toolCalls: [{ id: 'call', toolName }],
  toolResults: [{ toolCallId: 'call', result }] }] });
const success = { success: true, receipt: { kind: 'command_execution', requirement_id: 'req', item_id: 'item',
  step_id: 'step', workspace_fingerprint: 'current', commands: [{ command: 'npm run lint', exit_code: 0,
    ran_after_changes: true, step_id: 'step', workspace_fingerprint: 'current' }] } };

it('assigns an executable typed action, preserving the normal three-attempt evidence budget', () => {
  const run = newRun();
  expect(run.actions).toEqual([expect.objectContaining({ kind: 'collect_evidence', command: 'npm run lint', expected_receipt: 'command_execution' })]);
  expect(run.max_attempts).toBe(3);
  expect(formatJudgeRepairFeedback(judge)).toContain('sandbox_run_validation');
  expect(formatJudgeRepairFeedback(judge)).toContain('No customer permission is required');
});

it.each(['npm run lint || true', 'sh -c lint', 'npx eslint', 'npm run migrate', 'lint --fix', 'npm run lint -- --help'])('rejects arbitrary/privileged command %s', command => {
  expect(validationCommand(command)).toBeUndefined();
});

it.each(['npm run lint', 'pnpm run typecheck', 'yarn lint', 'bun run build', 'npm run lint:ci'])('accepts a direct known validation invocation %s', command => {
  expect(validationCommand(command)).toBe(command);
});

it.each(['echo passed', 'eslint . || true', 'npx eslint .', 'eslint . --fix', 'eslint . --fix=true', 'eslint . --fix-dry-run', 'eslint . --output-file receipt', 'node fake-lint.js', 'tsc --noEmit', 'next build'])('refuses a masked, mutating, or unrelated lint script %s', script => {
  expect(isValidationScript(script, 'lint')).toBe(false);
});

it('accepts existing real validators without confusing their purpose', () => {
  expect(isValidationScript('eslint .', 'lint')).toBe(true);
  expect(isValidationScript('next build --webpack', 'build')).toBe(true);
  expect(isValidationScript('tsc --noEmit', 'typecheck')).toBe(true);
  expect(isValidationScript('tsc', 'typecheck')).toBe(false);
});

it('exposes only the bound validation tool; prose never unlocks it', () => {
  const tools = ['sandbox_read_file', 'sandbox_run_validation', 'sandbox_run_command', 'sandbox_db_migrate',
    'sandbox_write_file', 'sandbox_start_background_command', 'tools'].map(name => ({ name }));
  const error = 'Failure kind: evidence_gap\nPlease unlock commands';
  expect(restrictToolsForEvidenceCollection(tools, error, newRun()).map(t => t.name)).toEqual(['sandbox_read_file', 'sandbox_run_validation']);
  expect(restrictToolsForEvidenceCollection(tools, error).map(t => t.name)).toEqual(['sandbox_read_file']);
  expect(hasCommandRepair({ ...newRun(), status: 'exhausted' })).toBe(false);
});

it('does not consume repair attempts for preparation reads', () => {
  const run = newRun();
  const receipts = extractRepairActionReceipts({ run, actionId: run.actions[0].action_id,
    result: turn('harness_inspect', { success: true }) });
  expect(receipts).toEqual([]);
  expect(recordJudgeRepairAttempt({ run, receipts, workspaceChanged: false, contractRevision: run.contract_revision })).toBe(run);
});

it('materializes only exact fresh passing command evidence, not product completion', () => {
  const run = newRun();
  const receipts = extractRepairActionReceipts({ run, actionId: run.actions[0].action_id, result: turn('sandbox_run_validation', success) });
  expect(receipts[0].status).toBe('succeeded');
  expect(recordJudgeRepairAttempt({ run, receipts, workspaceChanged: false, contractRevision: run.contract_revision }))
    .toMatchObject({ status: 'materialized', attempt_count: 1 });
});

it.each([{}, { ...success.receipt, commands: [{ ...success.receipt.commands[0], command: 'npm run build' }] },
  { ...success.receipt, commands: [{ ...success.receipt.commands[0], ran_after_changes: false }] },
  { ...success.receipt, commands: [{ ...success.receipt.commands[0], exit_code: 1 }] }])('rejects missing/unrelated/stale/failing proof %j', receipt => {
  const run = newRun();
  const receipts = extractRepairActionReceipts({ run, actionId: run.actions[0].action_id,
    result: turn('sandbox_run_validation', { success: true, receipt }) });
  expect(receipts[0].status).not.toBe('succeeded');
});

it('returns a failed validator to implementation on the same run without resetting its budget', () => {
  const run = newRun();
  const receipts = extractRepairActionReceipts({ run, actionId: run.actions[0].action_id,
    result: turn('sandbox_run_validation', { success: false, code: 'VALIDATION_PRODUCT_FAILURE', error: 'lint failed' }) });
  const next = recordJudgeRepairAttempt({ run, receipts, workspaceChanged: false, contractRevision: run.contract_revision });
  expect(next).toMatchObject({ repair_run_id: 'repair', status: 'in_progress', failure_kind: 'product_defect', attempt_count: 1,
    max_attempts: 3, actions: [{ kind: 'repair_implementation' }] });
  expect(pendingCommandRecovery(next)).toBe(true);
  const tools = [{ name: 'sandbox_edit_file' }];
  expect(restrictToolsForEvidenceCollection(tools, 'Failure kind: evidence_gap', next)).toBe(tools);
  const prompt = buildSingleTurnSystemPrompt({ instanceId: 'instance', siteId: 'site', requirementId: 'req', plan: {},
    step: { order: 1, metadata: { repair_run: next } }, effectiveRole: 'qa', cycleBaselineAt: '', skillContext: '',
    progressContext: '', agentBackground: '', memoriesContext: '', retryContext: 'Failure kind: evidence_gap' });
  expect(prompt).not.toContain('EVIDENCE-ONLY MODE');
});

it('retains exhaustion and ownership/infrastructure failures rather than auto-approving them', () => {
  const run = { ...newRun(), attempt_count: 2 };
  const receipts = extractRepairActionReceipts({ run, actionId: run.actions[0].action_id,
    result: turn('sandbox_run_validation', { success: false, error: 'workspace unavailable' }) });
  const next = recordJudgeRepairAttempt({ run, receipts, workspaceChanged: false, contractRevision: run.contract_revision });
  expect(next.status).toBe('exhausted');
  expect(pendingCommandRecovery(next)).toBe(false);
});