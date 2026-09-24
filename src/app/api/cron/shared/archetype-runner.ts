/** Deterministic Critic and Judge rules for persisted execution evidence. */

import type { BacklogItem, BacklogItemKind } from '@/lib/services/requirement-backlog-types';
import type { RequirementKind } from '@/lib/services/requirement-flows';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';
import {
  acceptanceValidation,
  requiresSuccessfulTestEvidence,
} from './archetype-acceptance-policy';
import { extractRequirementConstraints, findConstraintViolations } from '@/lib/services/requirement-constraints';
import {
  commitSummary,
  evidenceClaim,
  evidenceHaystack,
  featureCoverageEvidenceGap,
  featureCoverageFailure,
  gateSignals,
  hasToolCall,
  isAdminOnlyDiff,
  isLandingOnlyDiff,
  toolCalls,
} from './archetype-evidence';
import {
  matchOrEscalateJudgeResult as matchOrEscalate,
  rejectedJudgeResult as rejected,
  type JudgeResult,
} from './archetype-judge-result';
export type {
  JudgeFailureKind,
  JudgeResult,
  JudgeVerdict,
} from './archetype-judge-result';

export type CriticSeverity = 'blocker' | 'major' | 'minor';

export interface CriticSuggestion {
  rule: string;
  severity: CriticSeverity;
  fix_hint: string;
}

export interface CriticResult {
  ok: boolean;
  iterations: number;
  suggestions: CriticSuggestion[];
}

export interface ArchetypeContext {
  item: BacklogItem;
  evidence: EvidenceRecord;
  flow: RequirementKind;
}

function isTier(item: BacklogItem, tier: 'core' | 'ornamental'): boolean {
  return (item.tier ?? 'core') === tier;
}

// ─── Critic rules ───────────────────────────────────────────────────────

function criticGenericRules(ctx: ArchetypeContext): CriticSuggestion[] {
  const out: CriticSuggestion[] = [];
  const { item, evidence } = ctx;
  if (!item.acceptance || item.acceptance.length === 0) {
    out.push({
      rule: 'no-acceptance',
      severity: 'major',
      fix_hint: 'Backlog item has no acceptance criteria. Add at least one observable acceptance line via requirement_backlog upsert.',
    });
  } else {
    const validation = acceptanceValidation(item);
    if (!validation.has_any_executable && isTier(item, 'core')) {
      out.push({
        rule: 'narrative-acceptance',
        severity: 'blocker',
        fix_hint: `All ${item.acceptance.length} acceptance entr${item.acceptance.length === 1 ? 'y is' : 'ies are'} narrative. Rewrite at least one with a concrete anchor: HTTP verb (GET/POST), route (starting with /), status code, or observable verb (returns, renders, inserts, redirects). Narrative acceptance cannot be verified against evidence.`,
      });
    } else if (validation.unsupported.length > 0 && isTier(item, 'core')) {
      out.push({
        rule: 'partially-narrative-acceptance',
        severity: 'minor',
        fix_hint: `${validation.unsupported.length}/${item.acceptance.length} acceptance entries lack executable typed claims — judge will keep them unmatched.`,
      });
    }
  }
  const calls = toolCalls(evidence);
  const hasVerifiedArtifact = (
    evidence.feature_coverage?.artifact_proofs || []
  ).some((artifact) => artifact.exists && (artifact.bytes ?? 0) > 0);
  if (calls.length === 0 && !hasVerifiedArtifact) {
    out.push({
      rule: 'no-tool-calls',
      severity: 'blocker',
      fix_hint: 'Evidence has zero tool-calls. Run the work (build/test/curl) and re-record evidence with writeEvidence.',
    });
  }
  const c = commitSummary(evidence);
  if (isAdminOnlyDiff(c.files) && isTier(item, 'core')) {
    out.push({
      rule: 'admin-only-commit',
      severity: 'blocker',
      fix_hint: `Commit touches only docs / evidence / ground-truth files (${c.files.slice(0, 3).join(', ')}${c.files.length > 3 ? '…' : ''}). Core items must ship code changes under src/**. Either downgrade this item to tier='ornamental' via requirement_backlog upsert, or produce the actual code.`,
    });
  }
  if (evidence.feature_coverage) {
    for (const kr of evidence.feature_coverage.kind_requirements ?? []) {
      if (!kr.satisfied) {
        out.push({
          rule: `feature-coverage:${kr.requirement}`,
          severity: 'major',
          fix_hint: `kind=${kr.kind} contract failed: ${kr.requirement}. Detail: ${kr.detail || 'n/a'}`,
        });
      }
    }
    const missingPages =
      (evidence.feature_coverage.expected_page_routes?.length ?? 0) -
      (evidence.feature_coverage.present_page_files?.length ?? 0);
    const missingApis =
      (evidence.feature_coverage.expected_api_routes?.length ?? 0) -
      (evidence.feature_coverage.present_api_files?.length ?? 0);
    if (missingPages > 0 || missingApis > 0) {
      out.push({
        rule: 'feature-coverage:missing-routes',
        severity: 'major',
        fix_hint: `Acceptance / touches declared routes that do not exist on disk — pages missing: ${missingPages}, api handlers missing: ${missingApis}. Ship them or rewrite acceptance.`,
      });
    }
  }
  return out;
}

function criticAppRules(ctx: ArchetypeContext): CriticSuggestion[] {
  const out: CriticSuggestion[] = [];
  const sig = gateSignals(ctx.evidence);
  if (sig.build && sig.build.ok === false) {
    out.push({ rule: 'build-fail', severity: 'blocker', fix_hint: 'Build failed. Fix compile errors before claiming done.' });
  }
  if (sig.runtime && sig.runtime.ok === false) {
    out.push({ rule: 'runtime-fail', severity: 'blocker', fix_hint: 'Runtime probe failed. App did not boot — inspect server logs.' });
  }
  const files = commitSummary(ctx.evidence).files;
  if (isLandingOnlyDiff(files) && isTier(ctx.item, 'core') && (ctx.item.kind === 'page' || ctx.item.kind === 'component' || ctx.item.kind === 'crud' || ctx.item.kind === 'auth')) {
    out.push({
      rule: 'admin-only-landing',
      severity: 'blocker',
      fix_hint: `Core item kind=${ctx.item.kind} but commit only modified the root landing / components / globals.css. This is the "map-instead-of-product" pattern. Ship the actual feature: a nested page under src/app/<feature>/page.tsx, an API handler under src/app/api/<feature>/route.ts, or a real middleware — or downgrade to tier='ornamental'.`,
    });
  }

  const text = `${ctx.item.title} ${ctx.item.acceptance?.join(' ') || ''}`.toLowerCase();
  const involvesDb = ctx.item.kind === 'crud' || text.includes('database') || text.includes('supabase') || text.includes('table') || text.includes('schema');
  if (involvesDb && isTier(ctx.item, 'core')) {
    const touchedDb = files.some(f => f.includes('supabase/migrations/') || f.includes('schema') || f.includes('database'));
    if (!touchedDb) {
      out.push({
        rule: 'missing-db-schema',
        severity: 'major',
        fix_hint: `Item appears to involve database/supabase (kind=${ctx.item.kind}), but no migration or schema files were touched. Ensure you create Supabase migrations if adding new tables.`,
      });
    }
  }

  return out;
}

function criticDocRules(ctx: ArchetypeContext): CriticSuggestion[] {
  const out: CriticSuggestion[] = [];
  const calls = toolCalls(ctx.evidence);
  const hasVerifiedDocument = (
    ctx.evidence.feature_coverage?.artifact_proofs || []
  ).some(
    (artifact) =>
      artifact.exists &&
      (artifact.bytes ?? 0) > 0 &&
      /\.(?:md|mdx|txt)$/i.test(artifact.path),
  );
  if (
    !hasVerifiedDocument &&
    !calls.some((c) => /lint|markdown/i.test(c.name))
  ) {
    out.push({
      rule: 'no-markdown-lint',
      severity: 'major',
      fix_hint: 'Run a markdown lint pass (markdownlint or remark) and capture the result in evidence.tool_calls.',
    });
  }
  return out;
}

function criticByFlow(ctx: ArchetypeContext): CriticSuggestion[] {
  switch (ctx.flow) {
    case 'app':
    case 'site':
      return criticAppRules(ctx);
    case 'doc':
    case 'contract':
      return criticDocRules(ctx);
    default:
      return [];
  }
}

export function runCritic(ctx: ArchetypeContext, opts?: { maxIterations?: number }): CriticResult {
  const maxIterations = Math.max(1, Math.min(2, opts?.maxIterations ?? 2));
  const flowSuggestions =
    ctx.item.kind === 'doc'
      ? criticDocRules(ctx)
      : criticByFlow(ctx);
  const suggestions = [...criticGenericRules(ctx), ...flowSuggestions];
  return {
    ok: suggestions.filter((s) => s.severity === 'blocker').length === 0,
    iterations: maxIterations,
    suggestions,
  };
}

// ─── Judge per-flow rules ───────────────────────────────────────────────

function judgeApp(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  const sig = gateSignals(evidence);
  
  if (sig.build && !sig.build.ok) {
    const detail = sig.build.detail ? `: ${sig.build.detail}` : '';
    return rejected(item, `build gate failed${detail}. Fix the build errors before re-claiming done.`);
  }
  
  if (sig.runtime && sig.runtime.ok === false) {
    const detail = sig.runtime.detail ? `: ${sig.runtime.detail}` : '';
    return rejected(item, `runtime gate failed${detail}. Fix the failing route/response before re-claiming done.`);
  }
  
  if (sig.scenarios && sig.scenarios.ok === false) {
    const detail = sig.scenarios.detail ? `: ${sig.scenarios.detail}` : '';
    return rejected(item, `scenario gate failed${detail}. Fix the failing scenarios before re-claiming done.`);
  }

  // Phase 10: hard contracts for core items.
  if (isTier(item, 'core')) {
    const coverageGap = featureCoverageEvidenceGap(evidence);
    if (coverageGap) {
      return rejected(item, coverageGap, 'evidence_gap');
    }
    const coverageFailure = featureCoverageFailure(evidence);
    if (coverageFailure) {
      return rejected(item, coverageFailure);
    }
    const narrative = !acceptanceValidation(item).has_any_executable;
    if (narrative) {
      return rejected(
        item,
        'core item has only narrative acceptance — rewrite with an executable anchor (route, HTTP verb, status code, observable verb) or downgrade to tier=ornamental',
        'contract_error',
      );
    }
    if (isAdminOnlyDiff(evidence.changed_files ?? [])) {
      return rejected(item, 'core item commit is admin-only (docs/evidence/ground-truth). Ship code under src/** or set tier=ornamental.');
    }
    
    const hasPassingTests =
      evidence.tests?.some(
        (test) => test.exit_code === 0 && test.ran_after_changes,
      ) ?? false;
    if (requiresSuccessfulTestEvidence(item) && !hasPassingTests) {
      return rejected(
        item,
        'core item requires successful test evidence — write and run Jest tests before claiming done',
        'evidence_gap',
      );
    }

    const text = `${item.title} ${item.acceptance?.join(' ') || ''}`.toLowerCase();
    const involvesDb = item.kind === 'crud' || text.includes('database') || text.includes('supabase') || text.includes('table') || text.includes('schema');
    if (involvesDb) {
      const touchedDb = (evidence.changed_files ?? []).some(f => f.includes('supabase/migrations/') || f.includes('schema') || f.includes('database'));
      if (!touchedDb) {
        return rejected(item, 'core item requires database/schema changes, but no migration or schema files were touched. Create Supabase migrations or schema definitions.');
      }
    }

    const missingDeclaredTouches =
      evidence.feature_coverage?.missing_touches || [];
    if (missingDeclaredTouches.length > 0) {
      return rejected(
        item,
        `explicitly declared files are missing: ${missingDeclaredTouches.join(', ')}`,
      );
    }
    if (
      (item.kind === 'page' || item.kind === 'component' || item.kind === 'crud' || item.kind === 'auth') &&
      isLandingOnlyDiff(evidence.changed_files ?? [])
    ) {
      return rejected(item, `kind=${item.kind} but commit only changed landing/components (admin-only-landing pattern). Ship the real feature or downgrade.`);
    }
  }
  return matchOrEscalate(item, evidence);
}

function rejectUnmatchedConstraints(item: BacklogItem, evidence: EvidenceRecord): JudgeResult | null {
  const constraints = extractRequirementConstraints(
    ...(item.constraints || []),
    ...(item.acceptance || []),
    item.title,
  );
  if (!constraints.length) return null;
  const hay = [
    ...evidenceHaystack(evidence),
    (evidence.changed_files || []).join('\n'),
    JSON.stringify(evidence),
  ].join('\n');
  const hits = findConstraintViolations(hay, constraints);
  if (!hits.length) return null;
  const q = hits[0];
  return rejected(
    item,
    `unmatched_constraints: "${q.constraint}" violated by "${q.term}" — ${q.quote}`,
  );
}

function judgeDoc(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  const constraintHit = rejectUnmatchedConstraints(item, evidence);
  if (constraintHit) return constraintHit;
  const calls = toolCalls(evidence);
  const hasNonEmptyDocument = (
    evidence.feature_coverage?.artifact_proofs || []
  ).some(
    (artifact) =>
      artifact.exists &&
      (artifact.bytes ?? 0) > 0 &&
      /\.(?:md|mdx|txt)$/i.test(artifact.path),
  );
  if (
    !hasNonEmptyDocument &&
    !calls.some((c) => /lint|markdown|remark/i.test(c.name))
  ) {
    return rejected(
      item,
      'doc judge requires a lint/markdown tool call in evidence. Next: run a markdown/lint tool and keep the call in evidence.',
      'evidence_gap',
    );
  }
  return matchOrEscalate(item, evidence);
}

function judgeSlides(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  const calls = toolCalls(evidence);
  if (!calls.some((c) => /screenshot|capture|reveal|spectacle/i.test(c.name))) {
    return rejected(
      item,
      'slides judge requires per-slide screenshot evidence. Next: capture per-slide screenshots and keep them in evidence.',
      'evidence_gap',
    );
  }
  return matchOrEscalate(item, evidence);
}

function judgeContract(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  const claim = evidenceClaim(evidence);
  if (/\{\{\s*\w+\s*\}\}/.test(claim)) {
    return rejected(item, 'contract still has unresolved {{placeholders}}');
  }
  return matchOrEscalate(item, evidence);
}

function judgeBackend(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  if (!hasToolCall(
    evidence,
    (call) => call.ok && /curl|fetch|http|test/i.test(call.name),
  )) {
    return rejected(
      item,
      'backend judge requires an HTTP probe or test run. Next: curl/fetch the shipped route and keep a successful probe in evidence.',
      'evidence_gap',
    );
  }
  if (isTier(item, 'core')) {
    const coverageGap = featureCoverageEvidenceGap(evidence);
    if (coverageGap) {
      return rejected(item, coverageGap, 'evidence_gap');
    }
    const coverageFailure = featureCoverageFailure(evidence);
    if (coverageFailure) {
      return rejected(item, coverageFailure);
    }
    if (!acceptanceValidation(item).has_any_executable) {
      return rejected(
        item,
        'backend core item has narrative-only acceptance — add a concrete anchor (route/verb/status)',
        'contract_error',
      );
    }
    
    // TDD Assertion: Core items must have passing tests
    const hasPassingTests = evidence.tests?.some((t) => t.exit_code === 0 && t.ran_after_changes) ?? false;
    if (!hasPassingTests) {
      return rejected(
        item,
        'backend core item requires successful test evidence — write and run Jest tests before claiming done',
        'evidence_gap',
      );
    }

    const text = `${item.title} ${item.acceptance?.join(' ') || ''}`.toLowerCase();
    const involvesDb = item.kind === 'crud' || text.includes('database') || text.includes('supabase') || text.includes('table') || text.includes('schema');
    if (involvesDb) {
      const touchedDb = (evidence.changed_files ?? []).some(f => f.includes('supabase/migrations/') || f.includes('schema') || f.includes('database'));
      if (!touchedDb) {
        return rejected(item, 'backend core item requires database/schema changes, but no migration or schema files were touched. Create Supabase migrations or schema definitions.');
      }
    }

    const missingDeclaredTouches =
      evidence.feature_coverage?.missing_touches || [];
    if (missingDeclaredTouches.length > 0) {
      return rejected(
        item,
        `explicitly declared backend files are missing: ${missingDeclaredTouches.join(', ')}`,
      );
    }
    // Soft runtime check: at least one successful 2xx/3xx runtime tool call.
    const anyRuntimeOk = toolCalls(evidence).some((c) => /^curl\s/.test(c.name) && c.ok);
    if (!anyRuntimeOk) {
      return rejected(
        item,
        'backend core item needs at least one successful HTTP probe against the shipped route',
        'evidence_gap',
      );
    }
  }
  return matchOrEscalate(item, evidence);
}

function judgeTask(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  const constraintHit = rejectUnmatchedConstraints(item, evidence);
  if (constraintHit) return constraintHit;
  if (toolCalls(evidence).length === 0) {
    return rejected(
      item,
      'task judge requires at least one tool-call. Next: invoke at least one relevant tool and leave it in evidence.',
      'evidence_gap',
    );
  }
  return matchOrEscalate(item, evidence);
}

function judgeAutomation(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  if (!hasToolCall(evidence, (c) => /run|execute|cron|schedule|webhook/i.test(c.name))) {
    return rejected(
      item,
      'automation judge requires a runtime invocation. Next: execute the automation (run/cron/webhook) once and record the call.',
      'evidence_gap',
    );
  }
  return matchOrEscalate(item, evidence);
}

const JUDGE_BY_FLOW: Record<RequirementKind, (item: BacklogItem, evidence: EvidenceRecord) => JudgeResult> = {
  app: judgeApp,
  site: judgeApp,
  doc: judgeDoc,
  presentation: judgeSlides,
  contract: judgeContract,
  automation: judgeAutomation,
  task: judgeTask,
  makinari: judgeTask,
};

function judgeOverrideForKind(kind: BacklogItemKind | undefined): ((item: BacklogItem, evidence: EvidenceRecord) => JudgeResult) | null {
  if (!kind) return null;
  if (kind === 'auth' || kind === 'crud' || kind === 'integration') return judgeBackend;
  if (kind === 'doc') return judgeDoc;
  return null;
}

export function runJudge(ctx: ArchetypeContext): JudgeResult {
  const constraintHit = rejectUnmatchedConstraints(ctx.item, ctx.evidence);
  if (constraintHit) return constraintHit;
  const override = judgeOverrideForKind(ctx.item.kind);
  const fn = override ?? JUDGE_BY_FLOW[ctx.flow] ?? judgeTask;
  return fn(ctx.item, ctx.evidence);
}
