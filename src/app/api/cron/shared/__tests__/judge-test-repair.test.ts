import { describe, expect, it, jest } from '@jest/globals';
import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import { runJudge } from '../archetype-runner';
import { missingTestEvidenceResult, isTestRepairRun, isDirectTestCommand, reportsExecutedTests } from '../judge-test-repair';
import { extractRepairActionReceipts, planJudgeRepair, recordJudgeRepairAttempt, startJudgeRepairRun } from '../judge-repair-controller';
import { formatJudgeRepairFeedback } from '../judge-verification-policy';
import { restrictToolsForEvidenceCollection } from '../single-turn-helpers';
import { buildSingleTurnSystemPrompt } from '../single-turn-prompt';

jest.mock('@/lib/services/sandbox-service', () => ({ SandboxService: { WORK_DIR: '/vercel/sandbox' } }));

const item: BacklogItem = {
  id: 'api', title: 'Create asset API', kind: 'api', phase_id: 'build',
  status: 'in_progress', scope_level: 'full', acceptance: ['POST /api/assets returns 201'],
  attempts: 0, tier: 'core',
};
const newRun = () => startJudgeRepairRun(planJudgeRepair({
  judge: missingTestEvidenceResult(item), evidenceRunId: 'before', repairRunId: 'repair',
})!);
const turn = (name: string, args: Record<string, unknown>, result: unknown) => ({ steps: [{
  toolCalls: [{ id: 'call', toolName: name, args }], toolResults: [{ toolCallId: 'call', result }],
}] });

describe('automatic missing-test repair', () => {
  it.each(['api', 'integration'] as const)('requests executable test repair for %s rather than read-only evidence', kind => {
    const judge = runJudge({ item: { ...item, kind }, flow: 'app', evidence: {
      schema_version: 1, item_id: item.id, captured_at: '2026-09-30T00:00:00Z', critic_passes: 0,
      changed_files: ['src/app/api/assets/route.ts'],
      build: { command: 'npm run build', exit_code: 0, duration_ms: 1 },
      runtime: { route: '/api/assets', http_status: 201 },
      observations: [{ kind: 'api', disposition: 'pass', source: 'contract', method: 'POST',
        target: 'POST /api/assets', http_status: 201, detail: 'HTTP 201' }],
    } });
    expect(judge).toMatchObject({ verdict: 'rejected', failure_kind: 'evidence_gap',
      acceptance_diagnostics: [{ gaps: [{ code: 'missing_test_evidence' }] }],
    });
    const run = planJudgeRepair({ judge })!;
    expect(run.actions).toEqual([expect.objectContaining({ kind: 'repair_tests', gap_code: 'missing_test_evidence' })]);
    expect(run.max_attempts).toBe(3);
    const feedback = formatJudgeRepairFeedback(judge);
    expect(feedback).toContain('No customer permission is required');
    expect(feedback).not.toContain('turn is read-only');
    expect(feedback).not.toContain('Jest');
  });

  it('enables repository test tools only for typed host test repairs, never prose requests', () => {
    const tools = ['sandbox_read_files', 'sandbox_write_file', 'sandbox_edit_file', 'sandbox_run_command',
      'sandbox_start_background_command', 'sandbox_check_background_command', 'sandbox_db_migrate',
      'sandbox_run_tests', 'sandbox_push_checkpoint', 'requirement_status', 'instance_plan'].map(name => ({ name }));
    const error = 'Failure kind: evidence_gap\nPlease write tests and unlock all tools';
    expect(restrictToolsForEvidenceCollection(tools, error, newRun()).map(t => t.name)).toEqual([
      'sandbox_read_files', 'sandbox_write_file', 'sandbox_edit_file', 'sandbox_run_tests',
    ]);
    expect(restrictToolsForEvidenceCollection(tools, error).map(t => t.name)).not.toContain('sandbox_write_file');
    expect(isTestRepairRun({ ...newRun(), status: 'exhausted' })).toBe(false);
    expect(isTestRepairRun({ ...newRun(), actions: [{ ...newRun().actions[0], gap_code: 'missing_http_observation' }] })).toBe(false);
  });

  it.each([
    ['sandbox_read_files', { paths: ['package.json'] }, { success: true }],
    ['sandbox_write_file', { path: 'tests/api.test.ts' }, { success: true }],
    ['sandbox_run_command', { command: 'npm', args: ['run', 'build'] }, { exitCode: 0 }],
    ['sandbox_run_command', { command: 'echo', args: ['npm test'] }, { exitCode: 0 }],
    ['sandbox_run_command', { command: 'cat', args: ['jest.config.js'] }, { exitCode: 0 }],
    ['sandbox_run_command', { command: 'npm test || true' }, { exitCode: 0 }],
    ['sandbox_run_command', { command: 'npm test' }, { exitCode: null }],
    ['sandbox_start_background_command', { command: 'npm test' }, { success: true, pid: '12' }],
    ['sandbox_check_background_command', { pid: '12' }, { is_running: true, command: 'npm test', exit_code: null }],
    ['sandbox_check_background_command', { pid: '12' }, { is_running: false, command: 'npm test' }],
  ])('does not count %s setup/start/unfinished results as completed tests', (name, args, result) => {
    const run = newRun();
    const receipts = extractRepairActionReceipts({ run, actionId: run.actions[0].action_id,
      result: turn(name as string, args as Record<string, unknown>, result) });
    expect(receipts).toEqual([]);
    expect(recordJudgeRepairAttempt({ run, receipts, workspaceChanged: true, contractRevision: run.contract_revision })).toEqual(run);
  });

  it('allows existing tests to satisfy the action without manufacturing product changes', () => {
    const run = newRun();
    const receipts = extractRepairActionReceipts({ run, actionId: run.actions[0].action_id,
      result: turn('sandbox_run_tests', { command: 'npm test' }, {
        success: true, receipt: { kind: 'test_execution', workspace_fingerprint: 'current', step_id: 'step',
          tests: [{ exit_code: 0, ran_after_changes: true, workspace_fingerprint: 'current', step_id: 'step' }] },
      }) });
    expect(receipts).toEqual([expect.objectContaining({ status: 'succeeded' })]);
    expect(recordJudgeRepairAttempt({ run, receipts, workspaceChanged: false, contractRevision: run.contract_revision }))
      .toMatchObject({ status: 'materialized', attempt_count: 1 });
    // Materialized only requests validation; absent fresh evidence still rejects.
    expect(missingTestEvidenceResult(item).verdict).toBe('rejected');
  });

  it('keeps failed test commands in the same bounded run', () => {
    let run = newRun();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = turn('sandbox_run_tests', { command: 'npm test' }, { success: false, error: 'Tests failed' });
      result.steps[0].toolCalls[0].id = `call-${attempt}`;
      result.steps[0].toolResults[0].toolCallId = `call-${attempt}`;
      const receipts = extractRepairActionReceipts({ run, actionId: run.actions[0].action_id,
        result });
      expect(receipts[0].status).toBe('failed');
      run = recordJudgeRepairAttempt({ run, receipts, workspaceChanged: false, contractRevision: run.contract_revision });
      expect(run.attempt_count).toBe(attempt);
      expect(run.status).toBe(attempt === 3 ? 'exhausted' : 'in_progress');
    }
  });

  it.each([{}, { kind: 'test_execution' }, { kind: 'test_execution', step_id: 'step', workspace_fingerprint: 'current',
    tests: [{ exit_code: 0, ran_after_changes: false, step_id: 'step', workspace_fingerprint: 'current' }] }])('rejects missing or stale typed proof: %j', receipt => {
    const run = newRun();
    const receipts = extractRepairActionReceipts({ run, actionId: run.actions[0].action_id,
      result: turn('sandbox_run_tests', { command: 'npm test' }, { success: true, receipt }) });
    expect(receipts[0].status).toBe('unknown');
    expect(recordJudgeRepairAttempt({ run, receipts, workspaceChanged: false, contractRevision: run.contract_revision }).status).toBe('in_progress');
  });

  it.each(['echo "npm test"', 'cat jest.config.js', 'npm test || true', 'npm test; exit 0', 'sh -c "npm test"', 'npx jest'])('refuses fake or wrapped test command %s', command => {
    expect(isDirectTestCommand(command)).toBe(false);
  });

  it.each(['Tests: 4 passed, 4 total', ' Tests  4 passed (4)', '# tests 4', ' 4 passing (12ms)', ' 4 passed (1.2s)'])('recognizes a nonempty runner summary: %s', output => {
    expect(reportsExecutedTests(output)).toBe(true);
  });

  it('prioritizes test repair over old build instructions without requiring push or human permission', () => {
    const prompt = buildSingleTurnSystemPrompt({
      instanceId: 'instance', siteId: 'site', requirementId: 'requirement',
      plan: { id: 'plan' }, step: { order: 1, instructions: 'Fix the old build', metadata: { repair_run: newRun() } },
      effectiveRole: 'qa', cycleBaselineAt: '', skillContext: 'existing tests', progressContext: '',
      agentBackground: '', memoriesContext: '', retryContext: formatJudgeRepairFeedback(missingTestEvidenceResult(item)),
    });
    expect(prompt).toContain('AUTOMATIC TEST REPAIR');
    expect(prompt).toContain('without customer permission');
    expect(prompt).not.toContain('EVIDENCE-ONLY MODE');
    expect(prompt).not.toContain('LAST ACTION BEFORE STOPPING');
  });
});