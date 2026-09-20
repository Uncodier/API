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
  downgradeScope,
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

export interface PostGateGateSignals {
  build?: { ok: boolean };
  runtime?: {
    pages?: Array<{
      path?: string;
      http_status?: number;
      validation_required?: boolean;
      validation_disposition?: 'pass' | 'hard_fail' | 'unknown' | 'advisory';
    }>;
  };
  scenarios?: {
    scenarios?: Array<{ scenario: string; pass: boolean; duration_ms: number }>;
  };
  tests?: TestSignal;
  observations?: ProbeObservation[];
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
}

export interface RunArchetypePostGateResult {
  ran: boolean;
  judge_verdict?: 'approved' | 'rejected' | 'escalate';
  healing_applied?: string;
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

    // Phase 10: structural coverage check before the archetype pass. Runs
    // cheap `test -f` probes in the sandbox; any failure turns into a judge
    // rejection through the evidence.feature_coverage slice.
    let coverage: Awaited<ReturnType<typeof computeFeatureCoverage>> | null = null;
    try {
      coverage = await computeFeatureCoverage({
        sandbox: input.sandbox,
        // Structural coverage is derived only from the canonical backlog
        // contract. Plan-step prose can contain file paths and slash-separated
        // words that are useful context but are not required application URLs.
        item,
      });
    } catch (e: unknown) {
      throw new Error(
        `Feature coverage unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Reuse the diff-inference helper to enrich evidence with the list of
    // files this cycle actually changed. Critic / Judge use it to detect
    // admin-only commits and landing-only diffs.
    let changedFiles: string[] = input.signals.changed_files ?? [];
    if (changedFiles.length === 0) {
      try {
        const inferred = await inferTargetRoutesFromDiff(input.sandbox);
        changedFiles = inferred.changedFiles ?? [];
      } catch (e: unknown) {
        console.warn(`[CronStep] changed_files inference failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    const signalsWithDiff: PostGateGateSignals = { ...input.signals, changed_files: changedFiles };
    const hasFreshProducerEvidence =
      !!signalsWithDiff.build ||
      !!signalsWithDiff.runtime ||
      !!signalsWithDiff.scenarios ||
      !!signalsWithDiff.tests ||
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

    const evidenceRecord = buildEvidenceRecord(
      signalsWithDiff,
      input.capturedAt,
      coverage,
      evidenceRunId,
    );
    const persisted = await writeEvidence({
      sandbox: input.sandbox,
      cwd: SandboxService.WORK_DIR,
      requirementId: input.requirementId,
      itemId: item.id,
      record: evidenceRecord,
    });

    const archetypeCtx = {
      item: adjudicatedItem,
      evidence: persisted,
      flow: kind as RequirementKind,
    };
    const critic = runCritic(archetypeCtx);
    const judge = runJudge(archetypeCtx);

    await writeEvidence({
      sandbox: input.sandbox,
      cwd: SandboxService.WORK_DIR,
      requirementId: input.requirementId,
      itemId: item.id,
      record: {
        ...evidenceRecord,
        critic_passes: critic.iterations,
        judge_verdict: judge.verdict,
        judge_reason: judge.reason,
        judge_failure_kind: judge.failure_kind,
      },
    });

    let healingApplied: string | undefined;
    if (judge.verdict !== 'approved') {
      if (
        judge.failure_kind === 'evidence_gap' ||
        judge.failure_kind === 'contract_error'
      ) {
        const toolName =
          judge.failure_kind === 'evidence_gap'
            ? 'evidence_collector'
            : 'acceptance_contract';
        await recordToolFailure({
          requirementId: input.requirementId,
          itemId: item.id,
          toolName,
          reason:
            `[${judge.failure_kind}] ${judge.reason}`.slice(0, 400),
        });
        await logAssumption({
          requirementId: input.requirementId,
          itemId: item.id,
          assumption:
            `[${judge.failure_kind}] Retry verification without consuming ` +
            `the product attempt budget: ${judge.reason}`.slice(0, 800),
        });
        healingApplied =
          judge.failure_kind === 'evidence_gap'
            ? 'collect_evidence'
            : 'repair_contract';
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
        healingApplied = action.kind;
        switch (action.kind) {
          case 'rotate_strategy':
            await logAssumption({
              requirementId: input.requirementId,
              itemId: item.id,
              assumption: `[rotate] ${action.hint}`,
            });
            break;
          case 'downgrade_scope':
            await downgradeScope({
              requirementId: input.requirementId,
              itemId: item.id,
            });
            await logAssumption({
              requirementId: input.requirementId,
              itemId: item.id,
              assumption: `[downgrade ${action.from}→${action.to}] ${action.reason}`,
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
        feature_coverage: coverage ? summarizeFeatureCoverage(coverage) : 'n/a',
        healing_applied: healingApplied,
      },
    });

    return { ran: true, judge_verdict: judge.verdict, healing_applied: healingApplied };
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
  return {
    evidence_run_id: evidenceRunId,
    captured_at: capturedAt,
    build: signals.build
      ? { command: 'npm run build', exit_code: signals.build.ok ? 0 : 1, duration_ms: 0 }
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
    changed_files: signals.changed_files,
    observations: signals.observations,
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
