import { createHash, randomUUID } from 'node:crypto';
import type {
  AcceptanceCriterionDiagnostic,
  AcceptanceGapCode,
} from '@/lib/services/requirement-evidence-types';
import type {
  JudgeFailureKind,
  JudgeResult,
} from './archetype-judge-result';

export type RepairKind =
  | 'repair_implementation'
  | 'repair_contract'
  | 'collect_evidence'
  | 'resolve_environment';

export type RepairRunStatus =
  | 'planned'
  | 'in_progress'
  | 'materialized'
  | 'exhausted';

export interface RepairAction {
  action_id: string;
  kind: RepairKind;
  criterion_id?: string;
  gap_code?: AcceptanceGapCode;
  instruction: string;
  verification: string;
}

export interface RepairActionReceipt {
  receipt_id: string;
  repair_run_id: string;
  action_id: string;
  attempt: number;
  tool_call_id: string;
  tool_name: string;
  action_digest?: string;
  tool_arguments_excerpt?: string;
  status: 'succeeded' | 'failed';
  attempted_at: string;
  result_excerpt?: string;
}

export interface JudgeRepairRun {
  schema_version: 1;
  diagnostic_id: string;
  repair_run_id: string;
  status: RepairRunStatus;
  failure_kind: JudgeFailureKind;
  source_evidence_run_id?: string;
  contract_revision: string;
  created_at: string;
  max_attempts: number;
  attempt_count?: number;
  action_receipts?: RepairActionReceipt[];
  workspace_changed?: boolean;
  materialized_contract_revision?: string;
  actions: RepairAction[];
}

const TOOL_POLICY_BY_REPAIR_KIND: Record<RepairKind, RegExp> = {
  repair_implementation:
    /(?:edit|write|patch|replace|delete|move|rename|run_command|execute|checkpoint|backlog)/i,
  repair_contract:
    /(?:backlog|contract|requirement|edit|write|patch|replace|run_command)/i,
  collect_evidence:
    /(?:test|probe|browser|request|fetch|curl|run_command|check_background|read_logs|screenshot|assert|validate)/i,
  resolve_environment:
    /(?:run_command|background|deploy|environment|secret|key|install|restore|checkpoint|browser)/i,
};

function toolCanExecuteRepair(kind: RepairKind, toolName: string): boolean {
  return TOOL_POLICY_BY_REPAIR_KIND[kind].test(toolName);
}

function repairKindFor(
  failureKind: JudgeFailureKind,
  gapClass?: 'product' | 'evidence' | 'contract' | 'capability',
): RepairKind {
  const effective = gapClass || (
    failureKind === 'product_defect' ? 'product' :
    failureKind === 'contract_error' ? 'contract' :
    failureKind === 'capability_gap' ? 'capability' : 'evidence'
  );
  if (effective === 'product') return 'repair_implementation';
  if (effective === 'contract') return 'repair_contract';
  if (effective === 'capability') return 'resolve_environment';
  return 'collect_evidence';
}

function verificationFor(kind: RepairKind, required: string): string {
  if (kind === 'repair_implementation') {
    return `Re-run only the probes and tests that cover: ${required}.`;
  }
  if (kind === 'repair_contract') {
    return 'Persist a new executable contract revision, then collect fresh evidence for its typed targets.';
  }
  if (kind === 'resolve_environment') {
    return 'Record the restored capability or precondition before requesting a fresh Judge run.';
  }
  return `Collect a fresh typed receipt that directly proves: ${required}.`;
}

function actionsFromDiagnostics(
  diagnostics: AcceptanceCriterionDiagnostic[],
  failureKind: JudgeFailureKind,
): RepairAction[] {
  const actions = diagnostics.flatMap((diagnostic) =>
    diagnostic.gaps.map((gap, gapIndex) => {
      const kind = repairKindFor(failureKind, gap.class);
      return {
        action_id: `${diagnostic.criterion_id}:${gap.code}:${gapIndex + 1}`,
        kind,
        criterion_id: diagnostic.criterion_id,
        gap_code: gap.code,
        instruction: gap.suggested_action,
        verification: verificationFor(kind, gap.required),
      } satisfies RepairAction;
    }),
  );
  return Array.from(new Map(
    actions.map((action) => [
      `${action.kind}:${action.criterion_id || ''}:${action.gap_code || ''}:${action.instruction}`,
      action,
    ]),
  ).values());
}

export function contractRevisionFor(contract: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(contract ?? null))
    .digest('hex')
    .slice(0, 16);
}

export function planJudgeRepair(params: {
  judge: JudgeResult;
  evidenceRunId?: string;
  acceptanceContract?: unknown;
  createdAt?: string;
  repairRunId?: string;
}): JudgeRepairRun | undefined {
  if (params.judge.verdict === 'approved' || !params.judge.failure_kind) {
    return undefined;
  }
  const diagnostics = params.judge.acceptance_diagnostics || [];
  const fallbackKind = repairKindFor(params.judge.failure_kind);
  const actions = actionsFromDiagnostics(diagnostics, params.judge.failure_kind);
  if (actions.length === 0) {
    actions.push({
      action_id: `judge:${fallbackKind}:1`,
      kind: fallbackKind,
      instruction: params.judge.reason,
      verification: verificationFor(
        fallbackKind,
        params.judge.unmatched_acceptance[0] || params.judge.reason,
      ),
    });
  }
  const diagnosticId = createHash('sha256').update(JSON.stringify({
    failure_kind: params.judge.failure_kind,
    unmatched: params.judge.unmatched_acceptance,
    diagnostics,
  })).digest('hex').slice(0, 20);
  return {
    schema_version: 1,
    diagnostic_id: diagnosticId,
    repair_run_id: params.repairRunId || randomUUID(),
    status: 'planned',
    failure_kind: params.judge.failure_kind,
    source_evidence_run_id: params.evidenceRunId,
    contract_revision: contractRevisionFor(params.acceptanceContract),
    created_at: params.createdAt || new Date().toISOString(),
    max_attempts:
      (params.judge.failure_kind === 'capability_gap' ? 1 : 3) *
      Math.max(actions.length, 1),
    attempt_count: 0,
    action_receipts: [],
    actions,
  };
}

export function startJudgeRepairRun(run: JudgeRepairRun): JudgeRepairRun {
  if (run.status !== 'planned') return run;
  return {
    ...run,
    status: 'in_progress',
    attempt_count: run.attempt_count || 0,
    action_receipts: run.action_receipts || [],
  };
}

function resultExcerpt(value: unknown): string | undefined {
  if (value == null) return undefined;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.replace(/\s+/g, ' ').trim().slice(0, 500) || undefined;
  } catch {
    return '[unserializable result]';
  }
}

function toolResultFailed(result: {
  isError?: unknown;
  result?: unknown;
  cleanedResult?: unknown;
}): boolean {
  if (result.isError === true) return true;
  const payload = result.cleanedResult ?? result.result;
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  const exitCode = Number(record.exitCode ?? record.exit_code);
  return record.success === false || record.failed === true ||
    record.error != null || (Number.isFinite(exitCode) && exitCode !== 0);
}

function toolResultSucceeded(toolResult: {
  isError?: unknown;
  result?: unknown;
  cleanedResult?: unknown;
}): boolean {
  if (toolResultFailed(toolResult)) return false;
  const payload = toolResult.cleanedResult ?? toolResult.result;
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  const exitCode = Number(record.exitCode ?? record.exit_code);
  return record.success === true ||
    record.ok === true ||
    record.completed === true ||
    record.status === 'succeeded' ||
    record.status === 'completed' ||
    (Number.isFinite(exitCode) && exitCode === 0);
}

/**
 * Converts one assistant turn into durable, action-scoped receipts. The
 * executor selects the action from persisted state; prose alone and unmatched
 * tool results are never receipts.
 */
export function extractRepairActionReceipts(params: {
  run: JudgeRepairRun;
  actionId: string;
  result: {
    steps?: Array<{
      toolCalls?: Array<{
        id?: string;
        toolCallId?: string;
        toolName?: string;
        args?: Record<string, unknown>;
      }>;
      toolResults?: Array<{
        toolCallId?: string;
        isError?: unknown;
        result?: unknown;
        cleanedResult?: unknown;
      }>;
    }>;
  };
  attemptedAt?: string;
}): RepairActionReceipt[] {
  const action = params.run.actions.find(
    (candidate) => candidate.action_id === params.actionId,
  );
  if (!action) return [];
  const attempt = (params.run.attempt_count || 0) + 1;
  const attemptedAt = params.attemptedAt || new Date().toISOString();
  const receipts: RepairActionReceipt[] = [];
  for (const step of params.result.steps || []) {
    const results = new Map(
      (step.toolResults || []).map((result) => [result.toolCallId, result]),
    );
    for (const call of step.toolCalls || []) {
      const callId = call.id || call.toolCallId;
      if (!callId) continue;
      const result = results.get(callId);
      if (!result) continue;
      const status = toolResultSucceeded(result) ? 'succeeded' : 'failed';
      receipts.push({
        receipt_id: createHash('sha256')
          .update(`${params.run.repair_run_id}:${attempt}:${params.actionId}:${callId}:${status}`)
          .digest('hex')
          .slice(0, 24),
        repair_run_id: params.run.repair_run_id,
        action_id: params.actionId,
        attempt,
        tool_call_id: callId,
        tool_name: call.toolName || 'unknown',
        action_digest: createHash('sha256')
          .update(JSON.stringify(action))
          .digest('hex')
          .slice(0, 16),
        tool_arguments_excerpt: resultExcerpt(call.args),
        status,
        attempted_at: attemptedAt,
        result_excerpt: resultExcerpt(result.cleanedResult ?? result.result),
      });
    }
  }
  // One receipt is an unambiguous action attribution boundary. A multi-call
  // result or a tool incapable of this repair kind cannot satisfy the action.
  if (
    receipts.length !== 1 ||
    !toolCanExecuteRepair(action.kind, receipts[0].tool_name)
  ) {
    return [];
  }
  return receipts;
}

export function recordJudgeRepairAttempt(params: {
  run: JudgeRepairRun;
  receipts: RepairActionReceipt[];
  workspaceChanged: boolean;
  contractRevision: string;
}): JudgeRepairRun {
  const attemptCount = (params.run.attempt_count || 0) + 1;
  const existing = params.run.action_receipts || [];
  const receipts = Array.from(new Map(
    [...existing, ...params.receipts]
      .filter((receipt) => receipt.repair_run_id === params.run.repair_run_id)
      .map((receipt) => [receipt.receipt_id, receipt]),
  ).values());
  const succeeded = new Set(
    receipts
      .filter((receipt) => receipt.status === 'succeeded')
      .map((receipt) => receipt.action_id),
  );
  const allActionsSucceeded = params.run.actions.length > 0 &&
    params.run.actions.every((action) => succeeded.has(action.action_id));
  const kinds = new Set(params.run.actions.map((action) => action.kind));
  const workspaceChanged =
    params.run.workspace_changed === true || params.workspaceChanged;
  const materializedContractRevision =
    params.contractRevision !== params.run.contract_revision
      ? params.contractRevision
      : params.run.materialized_contract_revision;
  const materialChangeSatisfied =
    (!kinds.has('repair_implementation') || workspaceChanged) &&
    (!kinds.has('repair_contract') ||
      !!materializedContractRevision);
  return {
    ...params.run,
    attempt_count: attemptCount,
    action_receipts: receipts,
    workspace_changed: workspaceChanged,
    ...(materializedContractRevision
      ? { materialized_contract_revision: materializedContractRevision }
      : {}),
    status: allActionsSucceeded && materialChangeSatisfied
      ? 'materialized'
      : attemptCount >= params.run.max_attempts
        ? 'exhausted'
        : 'in_progress',
  };
}

export function formatRepairRunFeedback(run: JudgeRepairRun): string {
  const actions = run.actions.map((action, index) =>
    `${index + 1}. [${action.kind}] action_id=${action.action_id} ${action.instruction} Verification: ${action.verification}`,
  );
  return [
    `Repair run: ${run.status}${run.status === 'planned' ? ' (not yet applied)' : ''}`,
    `Diagnostic id: ${run.diagnostic_id}`,
    `Repair run id: ${run.repair_run_id}`,
    `Attempt: ${(run.attempt_count || 0) + 1}/${run.max_attempts}`,
    `Failure kind: ${run.failure_kind}`,
    `Contract revision: ${run.contract_revision}`,
    ...(run.source_evidence_run_id
      ? [`Source evidence run id: ${run.source_evidence_run_id}`]
      : []),
    'Execute only the affected actions below. The executor binds each tool call to the selected action structurally. Do not weaken acceptance. After execution, request fresh independent gate/Judge validation.',
    ...actions,
  ].join('\n');
}

export function materialHealingApplied(params: {
  run?: JudgeRepairRun;
  newEvidenceRunId?: string;
  sourceEvidenceRunId?: string;
  workspaceChanged?: boolean;
  contractRevisionChanged?: boolean;
  evidenceCaptured?: boolean;
}): RepairKind | undefined {
  if (!params.run || params.run.status !== 'materialized') return undefined;
  const hasFreshEvidence = !!params.newEvidenceRunId &&
    params.newEvidenceRunId !== params.sourceEvidenceRunId;
  if (!hasFreshEvidence || params.evidenceCaptured === false) return undefined;
  const successfulActionIds = new Set(
    (params.run.action_receipts || [])
      .filter((receipt) =>
        receipt.repair_run_id === params.run!.repair_run_id &&
        receipt.status === 'succeeded')
      .map((receipt) => receipt.action_id),
  );
  if (!params.run.actions.every((action) =>
    successfulActionIds.has(action.action_id))) return undefined;
  const kinds = new Set(params.run.actions.map((action) => action.kind));
  if (kinds.has('repair_implementation') && !params.workspaceChanged) return undefined;
  if (kinds.has('repair_contract') && !params.contractRevisionChanged) return undefined;
  return params.run.actions[0]?.kind;
}