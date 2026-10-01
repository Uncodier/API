import { describe, expect, it } from '@jest/globals';
import {
  continueJudgeRepairRun,
  planJudgeRepair,
  recordJudgeRepairAttempt,
  startJudgeRepairRun,
  type JudgeRepairRun,
} from '../judge-repair-controller';
import {
  MAX_REPAIR_VERIFICATION_OBSERVATIONS,
  type RepairVerificationContext,
} from '../judge-repair-observations';

function planned(evidenceId = 'evidence-0', fingerprint = 'workspace-a') {
  return planJudgeRepair({
    judge: {
      verdict: 'rejected',
      reason: 'GET /health has no direct evidence.',
      failure_kind: 'evidence_gap',
      matched_acceptance: [],
      unmatched_acceptance: ['GET /health returns 200'],
    },
    evidenceRunId: evidenceId,
    workspaceFingerprint: fingerprint,
    acceptanceContract: { revision: 1 },
    repairRunId: 'repair-1',
    createdAt: '2026-09-25T00:00:00.000Z',
  })!;
}

function attempt(run: JudgeRepairRun, status: 'succeeded' | 'failed' = 'succeeded') {
  const number = (run.attempt_count || 0) + 1;
  return recordJudgeRepairAttempt({
    run: startJudgeRepairRun(run),
    workspaceChanged: true,
    contractRevision: run.contract_revision,
    receipts: [{
      receipt_id: `receipt-${number}`,
      repair_run_id: run.repair_run_id,
      action_id: run.actions[0].action_id,
      attempt: number,
      tool_call_id: `call-${number}`,
      tool_name: 'sandbox_run_command',
      status,
      attempted_at: '2026-09-25T00:01:00.000Z',
    }],
  });
}

function verify(
  previous: JudgeRepairRun,
  evidenceId = 'evidence-1',
  fingerprint = 'workspace-a',
  overrides: Partial<RepairVerificationContext> = {},
  next: JudgeRepairRun = planned(evidenceId, fingerprint),
) {
  return continueJudgeRepairRun({
    previous,
    planned: next,
    evidenceRunId: evidenceId,
    verification: {
      evidenceRunId: evidenceId,
      workspaceFingerprint: fingerprint,
      capturedAt: '2026-09-25T00:02:00.000Z',
      evidenceCaptured: true,
      ...overrides,
    },
  });
}

describe('canonical repair verification observations', () => {
  it('records current unchanged evidence without treating tool success as repaired', () => {
    const applied = attempt(planned());
    expect(applied.status).toBe('materialized');
    const observed = verify(applied);
    expect(observed.verification_observations).toEqual([expect.objectContaining({
      source_evidence_run_id: 'evidence-0',
      latest_evidence_run_id: 'evidence-1',
      source_workspace_fingerprint: 'workspace-a',
      workspace_fingerprint: 'workspace-a',
      source_diagnostic_id: applied.diagnostic_id,
      diagnostic_id: applied.diagnostic_id,
      contract_revision: applied.contract_revision,
      applied_attempts: [1],
      receipt_ids: ['receipt-1'],
      status: 'same_failure_unchanged',
    })]);
    expect(observed).toMatchObject({ status: 'planned', attempt_count: 1, max_attempts: 3 });
    expect(observed.actions[0].verification).not.toContain('new hypothesis');
  });

  it('records the same failure after a changed fingerprint, not a causal claim', () => {
    const observed = verify(attempt(planned()), 'evidence-1', 'workspace-b');
    expect(observed.verification_observations?.[0].status).toBe('same_failure_after_change');
    expect(observed.verification_observations?.[0]).not.toHaveProperty('repaired');
  });

  it('uses adjacent evidence and distinct receipt-backed attempts for actionable feedback', () => {
    const first = verify(attempt(planned()), 'evidence-1', 'workspace-b');
    const second = verify(attempt(first, 'failed'), 'evidence-2', 'workspace-b');
    expect(second.verification_observations?.[1]).toMatchObject({
      source_evidence_run_id: 'evidence-1',
      latest_evidence_run_id: 'evidence-2',
      source_workspace_fingerprint: 'workspace-b',
      workspace_fingerprint: 'workspace-b',
      status: 'same_failure_unchanged',
      applied_attempts: [2],
    });
    expect(second.actions[0].verification).toContain('after 2 receipt-backed attempts');
    expect(second.actions[0].verification).toContain('evidence-1 -> evidence-2');
    expect(second.actions[0].verification).toContain('new hypothesis');
    expect(second.actions[0].verification).toContain('targeted check');
    expect(second.actions[0].verification).toContain('do not establish cause or repair');
    expect(second).toMatchObject({ attempt_count: 2, max_attempts: 3, status: 'planned' });
    expect(second.actions[0].kind).toBe(planned().actions[0].kind);
    expect(second.actions[0].instruction).toBe(planned().actions[0].instruction);
  });

  it('does not count replayed gate evidence or reset exhausted budgets even if diagnostics differ', () => {
    const observed = verify(attempt(planned()));
    const exhausted = { ...observed, status: 'exhausted' as const, attempt_count: 3 };
    const other = { ...planned(), diagnostic_id: 'different', max_attempts: 99 };
    expect(verify(exhausted, 'evidence-1', 'workspace-b', {}, other)).toBe(exhausted);
    expect(verify(exhausted, 'evidence-0')).toBe(exhausted);
    expect(continueJudgeRepairRun({
      previous: exhausted, planned: other, evidenceRunId: 'evidence-1',
    })).toBe(exhausted);
    expect(exhausted.verification_observations).toHaveLength(1);
    expect(exhausted).toMatchObject({ status: 'exhausted', attempt_count: 3, max_attempts: 3 });
  });

  it.each([
    ['source id', { source_evidence_run_id: undefined }, {}],
    ['source fingerprint', { source_workspace_fingerprint: undefined }, {}],
    ['latest id', {}, { evidenceRunId: undefined }],
    ['latest fingerprint', {}, { workspaceFingerprint: undefined }],
    ['fresh capture', {}, { evidenceCaptured: false }],
    ['source contract', { contract_revision: '' }, {}],
    ['source diagnostic', { diagnostic_id: '' }, {}],
    ['concrete receipts', { action_receipts: [] }, {}],
  ])('keeps missing %s unknown', (_name, runOverrides, contextOverrides) => {
    const observed = verify({ ...attempt(planned()), ...runOverrides },
      'evidence-1', 'workspace-b', contextOverrides);
    expect(observed.verification_observations?.[0].status).toBe('unknown');
    expect(observed.actions[0].verification).not.toContain('new hypothesis');
  });

  it('does not count unrelated receipts or a fresh verifier result as a new applied attempt', () => {
    const applied = attempt(planned());
    const unrelated = { ...applied, action_receipts: applied.action_receipts!.map((receipt) => ({
      ...receipt, repair_run_id: 'another-run',
    })) };
    expect(verify(unrelated).verification_observations?.[0].applied_attempts).toEqual([]);
    const first = verify(applied);
    const second = verify(first, 'evidence-2');
    expect(second.verification_observations?.[1]).toMatchObject({
      status: 'unknown', applied_attempts: [],
    });
    expect(second.attempt_count).toBe(1);
    expect(second.actions[0].verification).not.toContain('new hypothesis');
  });

  it('does not turn repeated missing-identity callbacks into fresh observations', () => {
    const first = verify(attempt(planned()), 'evidence-1', 'workspace-b', { evidenceRunId: undefined });
    const second = verify(first, 'evidence-1', 'workspace-b', {
      evidenceRunId: undefined, capturedAt: '2026-09-25T00:03:00.000Z',
    });
    expect(second.verification_observations).toEqual(first.verification_observations);
    expect(second.verification_observations).toHaveLength(1);
    expect(second.attempt_count).toBe(1);
  });

  it('does not escalate after two executions with only one fresh verification', () => {
    const observed = verify(attempt(attempt(planned())));
    expect(observed.verification_observations?.[0].applied_attempts).toEqual([1, 2]);
    expect(observed.actions[0].verification).not.toContain('new hypothesis');
  });

  it('makes contract changes noncomparable without modifying the existing same-diagnostic budget', () => {
    const first = verify(attempt(planned()));
    const next = { ...planned('evidence-2'), contract_revision: 'contract-new' };
    const observed = verify(attempt(first), 'evidence-2', 'workspace-a', {}, next);
    expect(observed.verification_observations?.[1]).toMatchObject({
      status: 'unknown',
      source_contract_revision: first.contract_revision,
      contract_revision: 'contract-new',
    });
    expect(observed).toMatchObject({ attempt_count: 2, max_attempts: 3 });
    expect(observed.actions[0].verification).not.toContain('new hypothesis');
  });

  it('records a changed diagnostic as different, not repaired, preserving the existing reset', () => {
    const first = verify(attempt(planned()));
    const next = { ...planned('evidence-2'), diagnostic_id: 'diagnostic-new' };
    const observed = verify(attempt(first), 'evidence-2', 'workspace-b', {}, next);
    expect(observed.verification_observations?.[1]).toMatchObject({
      status: 'changed_diagnostic',
      source_diagnostic_id: first.diagnostic_id,
      diagnostic_id: 'diagnostic-new',
      applied_attempts: [2],
      attempt_count: 0,
    });
    expect(observed).toMatchObject({ attempt_count: 0, action_receipts: [], status: 'planned' });
    expect(observed.actions).toEqual(next.actions);
  });

  it('bounds observation history and never accumulates feedback suffixes', () => {
    let run = { ...planned(), max_attempts: 30 };
    for (let index = 1; index <= 20; index++) {
      run = verify(attempt(run), `evidence-${index}`, `workspace-${index}`);
    }
    expect(run.verification_observations).toHaveLength(MAX_REPAIR_VERIFICATION_OBSERVATIONS);
    expect(run.verification_observations?.at(-1)?.applied_attempts).toEqual([20]);
    expect(run.actions[0].verification.match(/Repair verification:/g)).toHaveLength(1);
    expect(run).toMatchObject({ attempt_count: 20, max_attempts: 30 });
  });
});