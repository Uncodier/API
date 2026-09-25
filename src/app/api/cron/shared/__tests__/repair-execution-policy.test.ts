import {
  canResumeCachedGate,
  shouldEnterRepairGateOnlyPhase,
  shouldRunGateAfterTurn,
} from '../repair-execution-policy';
import type { JudgeRepairRun, RepairAction } from '../judge-repair-controller';

const action: RepairAction = {
  action_id: 'action-1',
  kind: 'collect_evidence',
  instruction: 'Capture evidence.',
  verification: 'Run the probe.',
};

const run = (status: JudgeRepairRun['status']): JudgeRepairRun => ({
  schema_version: 1,
  diagnostic_id: 'diagnostic-1',
  repair_run_id: 'repair-1',
  status,
  failure_kind: 'evidence_gap',
  contract_revision: 'contract-1',
  created_at: '2026-09-25T00:00:00.000Z',
  max_attempts: 3,
  actions: [action],
});

describe('repair execution policy', () => {
  it('never resumes cached gate evidence over a pending repair action', () => {
    expect(canResumeCachedGate(run('in_progress'), action)).toBe(false);
    expect(canResumeCachedGate(run('in_progress'), undefined)).toBe(false);
    expect(canResumeCachedGate(undefined, undefined)).toBe(true);
  });

  it('forces a materialized repair directly into gate validation', () => {
    expect(shouldEnterRepairGateOnlyPhase(run('materialized'))).toBe(true);
    expect(shouldEnterRepairGateOnlyPhase(run('in_progress'))).toBe(false);
    expect(shouldRunGateAfterTurn({
      repairRun: run('materialized'),
      assistantDone: false,
      completionRequested: false,
    })).toBe(true);
  });

  it('blocks gate validation while a repair remains in progress', () => {
    expect(shouldRunGateAfterTurn({
      repairRun: run('in_progress'),
      assistantDone: true,
      completionRequested: true,
    })).toBe(false);
  });
});