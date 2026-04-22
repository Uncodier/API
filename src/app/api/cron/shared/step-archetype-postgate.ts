/**
 * Post-gate archetype pass: after the technical gate (build/runtime/deploy)
 * passes, we run the Critic + Judge against the backlog item linked to the
 * step, persist the evidence, and react to the Judge verdict using the
 * deterministic self-heal policy. This module extracts what was inlined in
 * `inline-step-executor.ts` so both files stay under the 500-line budget.
 */

import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { runCritic, runJudge } from './archetype-runner';
import { getBacklogItem, downgradeScope, logAssumption, markNeedsReview, setItemStatus } from '@/lib/services/requirement-backlog';
import { writeEvidence, type EvidenceRecord } from '@/lib/services/requirement-ground-truth';
import type { RequirementKind } from '@/lib/services/requirement-flows';
import { planNextHealingAction } from '@/lib/services/requirement-self-heal';
import {
  CronInfraEvent,
  logCronInfrastructureEvent,
  type CronAuditContext,
} from '@/lib/services/cron-audit-log';

export interface PostGateGateSignals {
  build?: { ok: boolean };
  runtime?: {
    pages?: Array<{ path?: string; http_status?: number }>;
  };
  scenarios?: {
    scenarios?: Array<{ scenario: string; pass: boolean; duration_ms: number }>;
  };
}

export interface RunArchetypePostGateInput {
  sandbox: Sandbox;
  requirementId: string;
  backlogItemId: string;
  stepId: string;
  signals: PostGateGateSignals;
  capturedAt: string;
  audit: CronAuditContext;
}

export interface RunArchetypePostGateResult {
  ran: boolean;
  judge_verdict?: 'approved' | 'rejected' | 'escalate';
  healing_applied?: string;
}

/**
 * Entry point used by the step executor after a successful technical gate.
 * Failures here are logged and swallowed — we must not block the step on
 * archetype issues; the next cycle picks it up via the persisted evidence.
 */
export async function runArchetypePostGate(
  input: RunArchetypePostGateInput,
): Promise<RunArchetypePostGateResult> {
  try {
    const { kind, item } = await getBacklogItem(input.requirementId, input.backlogItemId);
    if (!item) return { ran: false };

    const evidenceRecord = buildEvidenceRecord(input.signals, input.capturedAt);
    const persisted = await writeEvidence({
      sandbox: input.sandbox,
      cwd: SandboxService.WORK_DIR,
      requirementId: input.requirementId,
      itemId: item.id,
      record: evidenceRecord,
    });

    const archetypeCtx = { item, evidence: persisted, flow: kind as RequirementKind };
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
      },
    });

    let healingApplied: string | undefined;
    if (judge.verdict === 'approved') {
      await setItemStatus({ requirementId: input.requirementId, itemId: item.id, status: 'done' });
    } else {
      const action = planNextHealingAction({ item, verdict: judge, attempts: item.attempts });
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
          await downgradeScope({ requirementId: input.requirementId, itemId: item.id });
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

    await logCronInfrastructureEvent(input.audit, {
      event: CronInfraEvent.STEP_STATUS,
      message: `Critic+Judge for backlog item ${item.id}: ${judge.verdict}`,
      details: {
        step_id: input.stepId,
        backlog_item_id: item.id,
        critic_blockers: critic.suggestions.filter((s) => s.severity === 'blocker').length,
        critic_majors: critic.suggestions.filter((s) => s.severity === 'major').length,
        judge_verdict: judge.verdict,
        judge_reason: judge.reason,
        matched_acceptance: judge.matched_acceptance.length,
        unmatched_acceptance: judge.unmatched_acceptance.length,
        healing_applied: healingApplied,
      },
    });

    return { ran: true, judge_verdict: judge.verdict, healing_applied: healingApplied };
  } catch (e: unknown) {
    console.warn(
      `[CronStep] archetype runner failed (continuing): ${e instanceof Error ? e.message : e}`,
    );
    return { ran: false };
  }
}

function buildEvidenceRecord(
  signals: PostGateGateSignals,
  capturedAt: string,
): Omit<EvidenceRecord, 'item_id' | 'schema_version'> {
  return {
    captured_at: capturedAt,
    build: signals.build
      ? { command: 'npm run build', exit_code: signals.build.ok ? 0 : 1, duration_ms: 0 }
      : undefined,
    runtime: signals.runtime?.pages?.[0]
      ? {
          route: signals.runtime.pages[0].path ?? '/',
          http_status: signals.runtime.pages[0].http_status ?? 0,
        }
      : undefined,
    scenarios: signals.scenarios?.scenarios?.map((s) => ({
      name: s.scenario,
      pass: s.pass,
      duration_ms: s.duration_ms,
    })),
    critic_passes: 0,
  };
}

export function extractBacklogItemId(step: unknown): string | null {
  const s = step as { metadata?: { backlog_item_id?: string }; backlog_item_id?: string };
  return s?.metadata?.backlog_item_id ?? s?.backlog_item_id ?? null;
}
