/**
 * Post-gate archetype pass: after the technical gate (build/runtime/deploy)
 * passes, we run the Critic + Judge against the backlog item linked to the
 * step, persist the evidence, and react to the Judge verdict using the
 * deterministic self-heal policy. This module extracts what was inlined in
 * `inline-step-executor.ts` so both files stay under the 500-line budget.
 */

import type { Sandbox } from '@vercel/sandbox';
import { randomUUID } from 'node:crypto';
import { SandboxService } from '@/lib/services/sandbox-service';
import { runCritic, runJudge } from './archetype-runner';
import {
  bumpItemAttempts,
  getBacklogItem,
  logAssumption,
  markNeedsReview,
  recordToolFailure,
} from '@/lib/services/requirement-backlog';
import { writeEvidence, type EvidenceRecord } from '@/lib/services/requirement-ground-truth';
import type { RequirementKind } from '@/lib/services/requirement-flows';
import { planNextHealingAction } from '@/lib/services/requirement-self-heal';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';
import { computeFeatureCoverage, summarizeFeatureCoverage } from './feature-coverage';
import { inferTargetRoutesFromDiff } from './step-runtime-targets';
import type { TestSignal } from './step-test-evidence';
import type { ProbeObservation } from './step-probe-policy';
import type { InteractionSignal } from './step-interaction-audit';
import type { ScenarioSignal } from './step-iteration-signals';
import type {
  AcceptanceCriterionDiagnostic,
  ScenarioAssertionReceipt,
} from '@/lib/services/requirement-evidence-types';
import {
  formatJudgeRepairFeedback,
  judgeVerificationAttemptLimit,
  summarizeJudgeEvidenceGaps,
  verificationAttemptCount,
  verificationToolName,
} from './judge-verification-policy';
import type {
  JudgeFailureKind,
  JudgeVerdict,
} from './archetype-judge-result';
import {
  continueJudgeRepairRun,
  formatRepairRunFeedback,
  hasAttemptedJudgeRepair,
  materialHealingApplied,
  planJudgeRepair,
  type JudgeRepairRun,
} from './judge-repair-controller';

export interface PostGateGateSignals {
  build?: { ok: boolean; duration_ms?: number };
  runtime?: {
    pages?: Array<{
      path?: string;
      http_status?: number;
      validation_required?: boolean;
      validation_disposition?: 'pass' | 'hard_fail' | 'unknown' | 'advisory';
    }>;
  };
  scenarios?: ScenarioSignal;
  scenario_assertions?: ScenarioAssertionReceipt[];
  tests?: TestSignal;
  observations?: ProbeObservation[];
  interaction?: InteractionSignal;
  /**
   * Files actually modified by the producer in this cycle (sourced from
   * `git diff` inside the runtime probe). Passed to the archetype runner so
   * the Critic / Judge can enforce `admin-only-commit` + `admin-only-landing`.
   */
  changed_files?: string[];
}

export interface RunArchetypePostGateInput {
  sandbox: Sandbox;
  requirementId: string;
  backlogItemId: string;
  stepId: string;
  signals: PostGateGateSignals;
  capturedAt: string;
  evidenceRunId?: string;
  audit: CronAuditContext;
  contractAcceptance?: string[];
  repairRun?: JudgeRepairRun;
}

export interface RunArchetypePostGateResult {
  ran: boolean;
  judge_verdict?: JudgeVerdict;
  judge_reason?: string;
  judge_failure_kind?: JudgeFailureKind;
  matched_acceptance?: string[];
  unmatched_acceptance?: string[];
  acceptance_diagnostics?: AcceptanceCriterionDiagnostic[];
  repair_feedback?: string;
  repair_planned?: JudgeRepairRun;
  healing_applied?: string;
  verification_exhausted?: boolean;
  terminal_step_status?: 'cancelled';
  error?: string;
}

/**
 * Entry point used by the step executor after a successful technical gate.
 * Approval is returned to the caller so it can complete the plan step with a
 * CAS before moving the linked backlog item to done.
 */
export async function runArchetypePostGate(
  input: RunArchetypePostGateInput,
): Promise<RunArchetypePostGateResult> {
  try {
    const { kind, item } = await getBacklogItem(input.requirementId, input.backlogItemId);
    if (!item) {
      return {
        ran: false,
        error: `Backlog item ${input.backlogItemId} was not found`,
      };
    }
    const adjudicatedItem = input.contractAcceptance?.length
      ? {
          ...item,
          // A no-progress adjudication evaluates the current step contract,
          // not work intentionally assigned to later steps in the same item.
          acceptance: Array.from(new Set(input.contractAcceptance)),
        }
      : item;

    // Reuse diff inference for both structural coverage and archetype evidence.
    // Underspecified page/API contracts may use concrete changed route files;
    // otherwise coverage records an evidence gap instead of inventing a target.
    let changedFiles: string[] = input.signals.changed_files ?? [];
    if (changedFiles.length === 0) {
      try {
        const inferred = await inferTargetRoutesFromDiff(input.sandbox);
        changedFiles = inferred.changedFiles ?? [];
      } catch (e: unknown) {
        console.warn(`[CronStep] changed_files inference failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Phase 10: structural coverage check before the archetype pass.
    let coverage: Awaited<ReturnType<typeof computeFeatureCoverage>> | null = null;
    try {
      coverage = await computeFeatureCoverage({
        sandbox: input.sandbox,
        item: adjudicatedItem,
        // Intermediate adjudications must not enforce touches or kind-wide
        // deliverables assigned to later steps in the same backlog item.
        contractScoped: !!input.contractAcceptance?.length,
        changedFiles,
      });
    } catch (e: unknown) {
      throw new Error(
        `Feature coverage unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const signalsWithDiff: PostGateGateSignals = { ...input.signals, changed_files: changedFiles };
    const hasFreshProducerEvidence =
      !!signalsWithDiff.build ||
      !!signalsWithDiff.runtime ||
      !!signalsWithDiff.scenarios ||
      (signalsWithDiff.scenario_assertions?.length ?? 0) > 0 ||
      !!signalsWithDiff.tests ||
      !!signalsWithDiff.interaction ||
      (signalsWithDiff.changed_files?.length ?? 0) > 0 ||
      (signalsWithDiff.observations?.length ?? 0) > 0;
    const evidenceRunId =
      input.evidenceRunId ||
      (
        !hasFreshProducerEvidence &&
        item.evidence?.evidence_run_id
          ? item.evidence.evidence_run_id
          : randomUUID()
      );

    const baseEvidenceRecord = buildEvidenceRecord(
      signalsWithDiff,
      input.capturedAt,
      coverage,
      evidenceRunId,
    );
    const successfulRepairReceipts = (input.repairRun?.action_receipts || [])
      .filter((receipt) =>
        receipt.repair_run_id === input.repairRun?.repair_run_id &&
        receipt.status === 'succeeded')
      .map((receipt) => receipt.receipt_id);
    const evidenceRecord = {
      ...baseEvidenceRecord,
      ...(input.repairRun?.status === 'materialized' &&
      successfulRepairReceipts.length > 0
        ? {
            repair_provenance: {
              diagnostic_id: input.repairRun.diagnostic_id,
              repair_run_id: input.repairRun.repair_run_id,
              source_evidence_run_id:
                input.repairRun.source_evidence_run_id,
              action_ids: input.repairRun.actions.map(
                (action) => action.action_id,
              ),
              receipt_ids: successfulRepairReceipts,
            },
          }
        : {}),
    };
    const persisted = await writeEvidence({
      sandbox: input.sandbox,
      cwd: SandboxService.WORK_DIR,
      requirementId: input.requirementId,
      itemId: item.id,
      requireCanonicalPersistence: true,
      record: evidenceRecord,
    });

    const archetypeCtx = {
      item: adjudicatedItem,
      evidence: persisted,
      flow: kind as RequirementKind,
    };
    const critic = runCritic(archetypeCtx);
    const judge = runJudge(archetypeCtx);
    const healingApplied = judge.verdict === 'approved'
      ? materialHealingApplied({
          run: input.repairRun,
          newEvidenceRunId: evidenceRunId,
          sourceEvidenceRunId: input.repairRun?.source_evidence_run_id,
          workspaceChanged: input.repairRun?.workspace_changed,
          contractRevisionChanged:
            !!input.repairRun?.materialized_contract_revision,
          evidenceCaptured: hasFreshProducerEvidence,
        })
      : undefined;
    const newlyPlanned = planJudgeRepair({
      judge,
      evidenceRunId,
      acceptanceContract: adjudicatedItem.acceptance_contract,
      createdAt: input.capturedAt,
      repairRunId: input.repairRun?.repair_run_id,
    });
    let repairPlanned = judge.verdict === 'approved'
      ? input.repairRun
      : input.repairRun && newlyPlanned
        ? continueJudgeRepairRun({
            previous: input.repairRun,
            planned: newlyPlanned,
            evidenceRunId,
          })
        : newlyPlanned;
    if (
      judge.verdict !== 'approved' &&
      repairPlanned &&
      (repairPlanned.attempt_count || 0) >= repairPlanned.max_attempts
    ) {
      repairPlanned = { ...repairPlanned, status: 'exhausted' };
    }

    await writeEvidence({
      sandbox: input.sandbox,
      cwd: SandboxService.WORK_DIR,
      requirementId: input.requirementId,
      itemId: item.id,
      requireCanonicalPersistence: true,
      record: {
        ...evidenceRecord,
        critic_passes: critic.iterations,
        judge_verdict: judge.verdict,
        judge_reason: judge.reason,
        judge_failure_kind: judge.failure_kind,
        judge_matched_acceptance: judge.matched_acceptance,
        judge_unmatched_acceptance: judge.unmatched_acceptance,
        judge_acceptance_diagnostics: judge.acceptance_diagnostics,
      },
    });

    let verificationExhausted = false;
    let terminalStepStatus: 'cancelled' | undefined;
    if (judge.verdict !== 'approved') {
      const gapSummary = summarizeJudgeEvidenceGaps(judge);
      const toolName = verificationToolName(judge.failure_kind);
      if (toolName) {
        const updatedItem = await recordToolFailure({
          requirementId: input.requirementId,
          itemId: item.id,
          toolName,
          reason:
            (
              `[${judge.failure_kind}] ${judge.reason}` +
              `${gapSummary ? ` Gaps: ${gapSummary}` : ''}`
            ).slice(0, 400),
        });
        const verificationAttempts = verificationAttemptCount(
          updatedItem?.tool_failures,
          toolName,
        );
        const attemptLimit = judge.failure_kind === 'capability_gap'
          ? 1
          : judgeVerificationAttemptLimit();
        const canExhaustVerification =
          judge.failure_kind !== 'capability_gap' ||
          hasAttemptedJudgeRepair(
            input.repairRun,
            repairPlanned?.diagnostic_id,
          );
        if (verificationAttempts >= attemptLimit && canExhaustVerification) {
          const reason =
            `${judge.failure_kind} verification exhausted after ` +
            `${verificationAttempts} attempts: ${judge.reason}` +
            `${gapSummary ? ` Gaps: ${gapSummary}` : ''}`;
          await markNeedsReview({
            requirementId: input.requirementId,
            itemId: item.id,
            reason,
          });
          if (repairPlanned) repairPlanned = { ...repairPlanned, status: 'exhausted' };
          verificationExhausted = true;
          terminalStepStatus = 'cancelled';
        }
      } else {
        // Product defects use the bounded self-heal policy.
        const bumped = await bumpItemAttempts({
          requirementId: input.requirementId,
          itemId: item.id,
          reason: `judge_verdict=${judge.verdict}: ${(judge.reason || '').slice(0, 200)}`,
        });
        const attemptsForHeal =
          bumped?.attempts ?? (item.attempts ?? 0) + 1;
        const action = planNextHealingAction({
          item,
          verdict: judge,
          attempts: attemptsForHeal,
        });
        switch (action.kind) {
          case 'rotate_strategy':
            await logAssumption({
              requirementId: input.requirementId,
              itemId: item.id,
              assumption: `[rotate] ${action.hint}`,
            });
            break;
          case 'log_assumption_and_continue':
            await logAssumption({
              requirementId: input.requirementId,
              itemId: item.id,
              assumption: action.assumption,
            });
            break;
          case 'mark_needs_review':
            await markNeedsReview({
              requirementId: input.requirementId,
              itemId: item.id,
              reason: action.reason,
            });
            if (repairPlanned) repairPlanned = { ...repairPlanned, status: 'exhausted' };
            verificationExhausted = true;
            terminalStepStatus = 'cancelled';
            break;
        }
      }
    }

    await logCronInfrastructureEvent(input.audit, {
      event: CronInfraEvent.STEP_STATUS,
      message: `Critic+Judge for backlog item ${item.id}: ${judge.verdict}`,
      details: {
        step_id: input.stepId,
        backlog_item_id: item.id,
        tier: item.tier ?? 'core',
        critic_blockers: critic.suggestions.filter((s) => s.severity === 'blocker').length,
        critic_majors: critic.suggestions.filter((s) => s.severity === 'major').length,
        judge_verdict: judge.verdict,
        judge_reason: judge.reason,
        matched_acceptance: judge.matched_acceptance.length,
        unmatched_acceptance: judge.unmatched_acceptance.length,
        acceptance_diagnostics: judge.acceptance_diagnostics,
        diagnostic_id: repairPlanned?.diagnostic_id,
        repair_run_id: repairPlanned?.repair_run_id,
        repair_status: repairPlanned?.status,
        feature_coverage: coverage ? summarizeFeatureCoverage(coverage) : 'n/a',
        healing_applied: healingApplied,
        verification_exhausted: verificationExhausted,
      },
    });

    return {
      ran: true,
      judge_verdict: judge.verdict,
      judge_reason: judge.reason,
      judge_failure_kind: judge.failure_kind,
      matched_acceptance: judge.matched_acceptance,
      unmatched_acceptance: judge.unmatched_acceptance,
      acceptance_diagnostics: judge.acceptance_diagnostics,
      repair_feedback:
        judge.verdict === 'approved'
          ? undefined
          : [
              formatJudgeRepairFeedback(judge),
              repairPlanned ? formatRepairRunFeedback(repairPlanned) : '',
            ].filter(Boolean).join('\n\n'),
      repair_planned: repairPlanned,
      healing_applied: healingApplied,
      verification_exhausted: verificationExhausted,
      terminal_step_status: terminalStepStatus,
    };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(
      `[CronStep] archetype runner failed: ${error}`,
    );
    return { ran: false, error };
  }
}

function buildEvidenceRecord(
  signals: PostGateGateSignals,
  capturedAt: string,
  coverage: Awaited<ReturnType<typeof computeFeatureCoverage>> | null,
  evidenceRunId: string,
): Omit<EvidenceRecord, 'item_id' | 'schema_version'> {
  const runtimePage =
    signals.runtime?.pages?.find(
      (page) =>
        page.validation_required === true &&
        page.validation_disposition === 'pass',
    ) ||
    signals.runtime?.pages?.find(
      (page) =>
        page.http_status !== undefined &&
        page.http_status >= 200 &&
        page.http_status < 400,
    );
  const scenarioAssertions = [
    ...(signals.scenario_assertions || []),
    ...(signals.scenarios?.scenarios.flatMap(
      (scenario) =>
        scenario.steps.flatMap((step) => step.receipt ? [step.receipt] : []),
    ) || []),
  ];
  const responseObservations = scenarioAssertions
    .filter((receipt) => receipt.kind === 'http_response')
    .map((receipt) => ({
      kind: 'api',
      disposition: receipt.pass ? 'pass' as const : 'hard_fail' as const,
      source: 'e2e_scenario',
      target: receipt.target,
      detail:
        `${receipt.method} ${receipt.target} returned ${receipt.actual_status}`,
      method: receipt.method,
      http_status: receipt.actual_status,
      expected_statuses: receipt.expected_statuses,
    }));
  return {
    evidence_run_id: evidenceRunId,
    captured_at: capturedAt,
    build: signals.build
      ? {
          command: 'npm run build',
          exit_code: signals.build.ok ? 0 : 1,
          duration_ms: signals.build.duration_ms ?? 0,
        }
      : undefined,
    tests: signals.tests?.tests,
    runtime: runtimePage
      ? {
          route: runtimePage.path ?? '/',
          http_status: runtimePage.http_status ?? 0,
        }
      : undefined,
    scenarios: signals.scenarios?.scenarios?.map((s) => ({
      name: s.scenario,
      pass: s.pass,
      duration_ms: s.duration_ms,
    })),
    scenario_assertions:
      scenarioAssertions.length > 0 ? scenarioAssertions : undefined,
    changed_files: signals.changed_files,
    observations: [
      ...(signals.observations || []),
      ...responseObservations,
    ],
    interaction: signals.interaction
      ? {
          ok: signals.interaction.ok,
          evaluable: signals.interaction.evaluable,
          audited_files: signals.interaction.audited_files,
          links: signals.interaction.links,
          unresolved_links: signals.interaction.unresolved_links,
          findings: signals.interaction.findings,
          blocking_count: signals.interaction.blocking_count,
          deferred_count: signals.interaction.deferred_count,
          warning_count: signals.interaction.warning_count,
          summary: signals.interaction.summary,
        }
      : undefined,
    feature_coverage: coverage
      ? {
          ok: coverage.ok,
          evaluable: coverage.evaluable,
          declared_touches: coverage.declared_touches,
          present_touches: coverage.present_touches,
          missing_touches: coverage.missing_touches,
          not_evaluable_touches: coverage.not_evaluable_touches,
          expected_page_routes: coverage.expected_page_routes,
          expected_api_routes: coverage.expected_api_routes,
          present_page_files: coverage.present_page_files,
          present_api_files: coverage.present_api_files,
          not_evaluable_page_routes:
            coverage.not_evaluable_page_routes,
          not_evaluable_api_routes:
            coverage.not_evaluable_api_routes,
          acceptance_route_anchors: coverage.acceptance_route_anchors,
          artifact_proofs: coverage.artifact_proofs,
          kind_requirements: coverage.kind_requirements,
          probe_errors: coverage.probe_errors,
          summary: summarizeFeatureCoverage(coverage),
        }
      : undefined,
    critic_passes: 0,
  };
}

export function extractBacklogItemId(step: unknown): string | null {
  const s = step as { metadata?: { backlog_item_id?: string }; backlog_item_id?: string };
  return s?.metadata?.backlog_item_id ?? s?.backlog_item_id ?? null;
}
