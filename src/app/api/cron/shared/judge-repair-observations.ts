import { createHash } from 'node:crypto';
import type { JudgeRepairRun } from './judge-repair-controller';

export type RepairVerificationStatus =
  | 'same_failure_after_change'
  | 'same_failure_unchanged'
  | 'changed_diagnostic'
  | 'unknown';

export interface RepairVerificationObservation {
  observation_id: string;
  source_evidence_run_id?: string;
  latest_evidence_run_id?: string;
  source_workspace_fingerprint?: string;
  workspace_fingerprint?: string;
  source_diagnostic_id: string;
  diagnostic_id: string;
  source_contract_revision: string;
  contract_revision: string;
  /** Attempted executions since source evidence, including failed/unknown receipts;
   * not proof that a change was applied or caused the observed outcome. */
  applied_attempts: number[];
  receipt_ids: string[];
  /** Watermark in the continued run; diagnostic changes retain the existing reset. */
  attempt_count: number;
  observed_at?: string;
  status: RepairVerificationStatus;
}

export interface RepairVerificationContext {
  /** Only the canonical evidence returned by writeEvidence, never tool output. */
  evidenceRunId?: string;
  workspaceFingerprint?: string;
  capturedAt?: string;
  evidenceCaptured: boolean;
}

export const MAX_REPAIR_VERIFICATION_OBSERVATIONS = 12;
const MAX_OBSERVED_RECEIPTS = 32;

function identifier(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 200
    ? value : undefined;
}

function alreadyObserved(run: JudgeRepairRun, evidenceId?: string): boolean {
  return !!evidenceId && (
    run.source_evidence_run_id === evidenceId ||
    (run.verification_observations || []).some((observation) =>
      observation.latest_evidence_run_id === evidenceId ||
      observation.source_evidence_run_id === evidenceId)
  );
}

function observeVerification(
  previous: JudgeRepairRun,
  continued: JudgeRepairRun,
  evidence: RepairVerificationContext,
): JudgeRepairRun {
  const history = previous.verification_observations || [];
  const latest = history.at(-1);
  const sourceId = identifier(latest
    ? latest.latest_evidence_run_id : previous.source_evidence_run_id);
  const sourceFingerprint = identifier(latest
    ? latest.workspace_fingerprint : previous.source_workspace_fingerprint);
  const evidenceId = identifier(evidence.evidenceRunId);
  const fingerprint = identifier(evidence.workspaceFingerprint);
  const sourceContract = latest?.contract_revision ?? previous.contract_revision;
  const sourceDiagnostic = latest?.diagnostic_id ?? previous.diagnostic_id;
  if (latest && !evidenceId && !latest.latest_evidence_run_id &&
    latest.attempt_count === (continued.attempt_count || 0) &&
    latest.diagnostic_id === continued.diagnostic_id &&
    latest.contract_revision === continued.contract_revision) {
    // With no identity and no intervening execution, another gate callback
    // cannot establish a new observation (even if its timestamp changed).
    return { ...continued, verification_observations: history };
  }
  const baselineAttempt = latest?.attempt_count ?? 0;
  const receipts = (previous.action_receipts || []).filter((receipt) =>
    receipt.repair_run_id === previous.repair_run_id &&
    previous.actions.some((action) => action.action_id === receipt.action_id) &&
    Number.isInteger(receipt.attempt) &&
    receipt.attempt > baselineAttempt &&
    receipt.attempt <= (previous.attempt_count || 0));
  const appliedAttempts = Array.from(new Set(receipts.map((r) => r.attempt)))
    .sort((a, b) => a - b).slice(-MAX_OBSERVED_RECEIPTS);
  const comparable = !!sourceId && !!evidenceId && sourceId !== evidenceId &&
    !!sourceFingerprint && !!fingerprint && evidence.evidenceCaptured &&
    !!sourceContract && sourceContract === continued.contract_revision &&
    sourceContract === previous.contract_revision &&
    !!identifier(sourceDiagnostic) && !!identifier(continued.diagnostic_id) &&
    sourceDiagnostic === previous.diagnostic_id &&
    appliedAttempts.length > 0;
  const status: RepairVerificationStatus = !comparable ? 'unknown'
    : sourceDiagnostic !== continued.diagnostic_id ? 'changed_diagnostic'
      : sourceFingerprint !== fingerprint ? 'same_failure_after_change'
        : 'same_failure_unchanged';
  const observation = {
    source_evidence_run_id: sourceId,
    latest_evidence_run_id: evidenceId,
    source_workspace_fingerprint: sourceFingerprint,
    workspace_fingerprint: fingerprint,
    source_diagnostic_id: sourceDiagnostic,
    diagnostic_id: continued.diagnostic_id,
    source_contract_revision: sourceContract,
    contract_revision: continued.contract_revision,
    applied_attempts: appliedAttempts,
    receipt_ids: Array.from(new Set(receipts.map((r) => r.receipt_id)))
      .slice(-MAX_OBSERVED_RECEIPTS),
    attempt_count: continued.attempt_count || 0,
    status,
  };
  // Exclude wall-clock time: retrying missing/legacy context is not new evidence.
  const observationId = createHash('sha256')
    .update(JSON.stringify(observation)).digest('hex').slice(0, 24);
  if (history.some((entry) => entry.observation_id === observationId)) return continued;
  return {
    ...continued,
    verification_observations: [...history, {
      ...observation,
      observation_id: observationId,
      observed_at: evidence.capturedAt,
    }].slice(-MAX_REPAIR_VERIFICATION_OBSERVATIONS),
  };
}

function withRepeatedFailureFeedback(run: JudgeRepairRun): JudgeRepairRun {
  const repeated: RepairVerificationObservation[] = [];
  for (const observation of [...(run.verification_observations || [])].reverse()) {
    if (
      observation.source_diagnostic_id !== run.diagnostic_id ||
      observation.diagnostic_id !== run.diagnostic_id ||
      observation.source_contract_revision !== run.contract_revision ||
      observation.contract_revision !== run.contract_revision ||
      !['same_failure_after_change', 'same_failure_unchanged'].includes(observation.status)
    ) break;
    repeated.push(observation);
  }
  const attempts = new Set(repeated.flatMap((entry) => entry.applied_attempts));
  if (repeated.length < 2 || attempts.size < 2) return run;
  const latest = repeated[0];
  const feedback = [
    `Repair verification: diagnostic ${run.diagnostic_id} remains in ${repeated.length} fresh comparable evidence runs after ${attempts.size} receipt-backed attempts.`,
    `Latest comparison: ${latest.status}; attempted executions ${latest.applied_attempts.join(', ')}; receipts ${latest.receipt_ids.join(', ')} (including failed/unknown operations, not proven applied changes).`,
    `Inspect the exact canonical evidence ${latest.source_evidence_run_id} -> ${latest.latest_evidence_run_id}, diagnostic gaps, and action receipts before retrying.`,
    'These are evidence provenance IDs, not history log IDs. Check the current backlog-item mirror evidence/<item_id>.json and its evidence_run_id; if historical details are unavailable, keep them unknown rather than reconstructing them.',
    'State a new hypothesis and choose a targeted check for this same failure; do not repeat the same edit without new evidence.',
    'Workspace fingerprints and tool success do not establish cause or repair. Keep the existing acceptance, permissions, and repair budget.',
  ].join(' ');
  return {
    ...run,
    // The executor consumes action.verification, not just the formatted summary.
    actions: run.actions.map((action) => ({
      ...action,
      verification: `${action.verification}\n${feedback}`,
    })),
  };
}

export function continueJudgeRepairRun(params: {
  previous: JudgeRepairRun;
  planned: JudgeRepairRun;
  evidenceRunId: string;
  verification?: RepairVerificationContext;
}): JudgeRepairRun {
  const { previous, planned, verification } = params;
  // Replay must not re-plan actions, reset a diagnostic budget, or add an observation.
  const evidenceId = verification ? verification.evidenceRunId : params.evidenceRunId;
  if (alreadyObserved(previous, identifier(evidenceId))) {
    return previous;
  }
  const continued = previous.diagnostic_id !== planned.diagnostic_id ? planned : {
    ...planned,
    created_at: previous.created_at,
    max_attempts: previous.max_attempts,
    attempt_count: previous.attempt_count || 0,
    action_receipts: previous.action_receipts || [],
    source_evidence_run_id: previous.source_evidence_run_id || params.evidenceRunId,
    source_workspace_fingerprint: previous.source_workspace_fingerprint,
    verification_observations: previous.verification_observations,
    actions: planned.actions.map((action) => ({
      ...action,
      action_id: `${action.action_id}:round:${(previous.attempt_count || 0) + 1}`,
    })),
  };
  return verification
    ? withRepeatedFailureFeedback(observeVerification(previous, continued, verification))
    : continued;
}