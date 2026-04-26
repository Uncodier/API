/**
 * Archetype runner — Critic + Judge.
 *
 * Both archetypes are intentionally **deterministic** (rule-based) at this
 * phase rather than LLM-backed. The plan calls for "critic and judge run in
 * ephemeral sub-agent sessions"; we keep that contract by exporting two pure
 * functions whose inputs and outputs are typed and reproducible. Once the
 * harness is stable a future patch can swap the rule pass for an LLM
 * evaluator without changing call-sites in `inline-step-executor.ts`.
 *
 * Critic = bounded suggestions (no authority).
 * Judge  = single-shot verdict that decides item completion.
 *
 * Hard rule: the Judge ONLY approves when `evidence.tool_calls` carries
 * matching proof for every acceptance entry. Free-text claims are ignored.
 */

import type { BacklogItem, BacklogItemKind } from '@/lib/services/requirement-backlog-types';
import type { RequirementKind } from '@/lib/services/requirement-flows';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';
import { validateAcceptance } from '@/lib/services/requirement-acceptance';

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

export type JudgeVerdict = 'approved' | 'rejected' | 'escalate';

export interface JudgeResult {
  verdict: JudgeVerdict;
  reason: string;
  matched_acceptance: string[];
  unmatched_acceptance: string[];
}

export interface ArchetypeContext {
  item: BacklogItem;
  evidence: EvidenceRecord;
  flow: RequirementKind;
}

interface ToolCallSummary {
  name: string;
  ok: boolean;
  text?: string;
}

/**
 * Normalise the EvidenceRecord into a flat list of tool-call summaries.
 * Today the record exposes typed slices (build / tests / runtime / scenarios)
 * rather than a generic `tool_calls[]`. We map each slice into a synthetic
 * tool-call so the rule pass below can stay shape-agnostic.
 */
function toolCalls(evidence: EvidenceRecord): ToolCallSummary[] {
  const out: ToolCallSummary[] = [];
  if (evidence.build) {
    out.push({
      name: evidence.build.command || 'npm run build',
      ok: evidence.build.exit_code === 0,
      text: `exit_code=${evidence.build.exit_code} duration_ms=${evidence.build.duration_ms}`,
    });
  }
  for (const t of evidence.tests ?? []) {
    out.push({
      name: t.command,
      ok: t.exit_code === 0 && t.ran_after_changes,
      text: t.output_tail,
    });
  }
  if (evidence.runtime) {
    out.push({
      name: `curl ${evidence.runtime.route}`,
      ok: evidence.runtime.http_status >= 200 && evidence.runtime.http_status < 400,
      text: `status=${evidence.runtime.http_status}`,
    });
  }
  for (const s of evidence.scenarios ?? []) {
    out.push({
      name: `scenario:${s.name}`,
      ok: s.pass,
      text: `duration_ms=${s.duration_ms}`,
    });
  }
  return out;
}

function hasToolCall(evidence: EvidenceRecord, predicate: (c: ToolCallSummary) => boolean): boolean {
  return toolCalls(evidence).some(predicate);
}

function gateSignals(evidence: EvidenceRecord): {
  build?: { ok: boolean };
  runtime?: { ok: boolean };
  scenarios?: { ok: boolean };
} {
  const out: { build?: { ok: boolean }; runtime?: { ok: boolean }; scenarios?: { ok: boolean } } = {};
  if (evidence.build) out.build = { ok: evidence.build.exit_code === 0 };
  if (evidence.runtime) out.runtime = { ok: evidence.runtime.http_status >= 200 && evidence.runtime.http_status < 400 };
  if (evidence.scenarios?.length) out.scenarios = { ok: evidence.scenarios.every((s) => s.pass) };
  return out;
}

function commitSummary(evidence: EvidenceRecord): { sha?: string; files: string[] } {
  return { sha: evidence.commit_sha, files: evidence.changed_files ?? [] };
}

function isTier(item: BacklogItem, tier: 'core' | 'ornamental'): boolean {
  return (item.tier ?? 'core') === tier;
}

function isAdminOnlyDiff(files: string[]): boolean {
  if (!files.length) return false;
  return files.every((f) =>
    /\.md$/i.test(f) ||
    /^evidence\//.test(f) ||
    /^progress\.md$/i.test(f) ||
    /^DECISIONS\.md$/i.test(f) ||
    /^README(\.md)?$/i.test(f) ||
    /^feature_list\.json$/i.test(f) ||
    /^requirement\.spec\.md$/i.test(f) ||
    /^\.instructions$/i.test(f),
  );
}

function isLandingOnlyDiff(files: string[]): boolean {
  if (!files.length) return false;
  const code = files.filter((f) => /^src\//.test(f));
  if (!code.length) return false;
  // Landing-only = every code change is either the root page.tsx, layout.tsx,
  // a component under src/components/, or globals.css. No API route, no nested
  // /app/<feature>/page.tsx, no middleware, no lib/services/* touched.
  return code.every((f) =>
    /^src\/app\/page\.(t|j)sx?$/.test(f) ||
    /^src\/app\/layout\.(t|j)sx?$/.test(f) ||
    /^src\/app\/globals\.css$/.test(f) ||
    /^src\/components\//.test(f) ||
    /^src\/styles\//.test(f),
  );
}

function evidenceClaim(evidence: EvidenceRecord): string {
  const parts: string[] = [];
  if (evidence.judge_reason) parts.push(evidence.judge_reason);
  if (evidence.assumptions_logged?.length) parts.push(evidence.assumptions_logged.join(' | '));
  return parts.join('\n');
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
    const v = validateAcceptance(item.acceptance);
    if (!v.has_any_executable && isTier(item, 'core')) {
      out.push({
        rule: 'narrative-acceptance',
        severity: 'blocker',
        fix_hint: `All ${item.acceptance.length} acceptance entr${item.acceptance.length === 1 ? 'y is' : 'ies are'} narrative. Rewrite at least one with a concrete anchor: HTTP verb (GET/POST), route (starting with /), status code, or observable verb (returns, renders, inserts, redirects). Narrative acceptance cannot be verified against evidence.`,
      });
    } else if (v.narrative.length > 0 && isTier(item, 'core')) {
      out.push({
        rule: 'partially-narrative-acceptance',
        severity: 'minor',
        fix_hint: `${v.narrative.length}/${item.acceptance.length} acceptance entries lack concrete anchors — judge will ignore them when matching evidence.`,
      });
    }
  }
  const calls = toolCalls(evidence);
  if (calls.length === 0) {
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
          severity: 'blocker',
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
        severity: 'blocker',
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
  if (!calls.some((c) => /lint|markdown/i.test(c.name))) {
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
  const suggestions = [...criticGenericRules(ctx), ...criticByFlow(ctx)];
  return {
    ok: suggestions.filter((s) => s.severity === 'blocker').length === 0,
    iterations: maxIterations,
    suggestions,
  };
}

// ─── Judge per-flow rules ───────────────────────────────────────────────

function defaultUnmatched(item: BacklogItem): string[] {
  return [...(item.acceptance ?? [])];
}

/**
 * Phase 10: stricter acceptance matching.
 *
 *   1. Narrative acceptance (no anchor) is marked as unmatched regardless of
 *      evidence text — the Judge cannot rubber-stamp a landing just because
 *      some words overlap.
 *   2. Executable acceptance is matched via its anchors (routes, HTTP verbs,
 *      status codes, observable verbs) rather than generic 4-char keywords.
 *      A route anchor must appear verbatim in the haystack; a status-code
 *      anchor must appear as a number/status literal; an observable verb
 *      must co-occur with at least one other anchor or keyword from the
 *      acceptance line so we don't match "returns" anywhere in logs.
 */
function matchAcceptanceByKeywords(
  acceptance: string[],
  haystacks: string[],
): { matched: string[]; unmatched: string[] } {
  const matched: string[] = [];
  const unmatched: string[] = [];
  const validation = validateAcceptance(acceptance);
  const analysisByText = new Map(validation.analyses.map((a) => [a.text, a]));
  const haystackLower = haystacks.map((h) => h.toLowerCase());
  for (const a of acceptance) {
    const analysis = analysisByText.get(a);
    if (!analysis || !analysis.executable) {
      unmatched.push(a);
      continue;
    }
    // Every anchor must have at least one corroborating signal in the evidence.
    // This guards against "returns 200" matching a log line elsewhere — we
    // require at least 2 anchors to co-occur in the SAME haystack entry when
    // the line has ≥2 anchors, else the single anchor must appear.
    const anchorStrings = analysis.anchors.map((an) => an.value.toLowerCase());
    const minHits = Math.min(2, anchorStrings.length);
    const hit = haystackLower.some((hay) => {
      let count = 0;
      for (const anchor of anchorStrings) {
        if (hay.includes(anchor)) count++;
        if (count >= minHits) return true;
      }
      return count >= minHits;
    });
    if (hit) matched.push(a);
    else unmatched.push(a);
  }
  return { matched, unmatched };
}

function evidenceHaystack(evidence: EvidenceRecord): string[] {
  const calls = toolCalls(evidence).map((c) => `${c.name} ${c.text ?? ''}`);
  const sig = JSON.stringify(gateSignals(evidence));
  const claim = evidenceClaim(evidence);
  const commit = JSON.stringify(commitSummary(evidence));
  return [...calls, sig, claim, commit];
}

function judgeApp(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  const sig = gateSignals(evidence);
  if (sig.build && !sig.build.ok) return rejected(item, 'build gate failed');
  if (sig.runtime && sig.runtime.ok === false) return rejected(item, 'runtime gate failed');
  if (sig.scenarios && sig.scenarios.ok === false) return rejected(item, 'scenario gate failed');

  // Phase 10: hard contracts for core items.
  if (isTier(item, 'core')) {
    const narrative = !validateAcceptance(item.acceptance).has_any_executable;
    if (narrative) {
      return rejected(item, 'core item has only narrative acceptance — rewrite with an executable anchor (route, HTTP verb, status code, observable verb) or downgrade to tier=ornamental');
    }
    if (isAdminOnlyDiff(evidence.changed_files ?? [])) {
      return rejected(item, 'core item commit is admin-only (docs/evidence/ground-truth). Ship code under src/** or set tier=ornamental.');
    }
    
    // TDD Assertion: Core items must have passing tests
    const hasPassingTests = evidence.tests?.some((t) => t.exit_code === 0 && t.ran_after_changes) ?? false;
    if (!hasPassingTests) {
      return rejected(item, 'core item requires successful test evidence — write and run Jest tests before claiming done');
    }

    const text = `${item.title} ${item.acceptance?.join(' ') || ''}`.toLowerCase();
    const involvesDb = item.kind === 'crud' || text.includes('database') || text.includes('supabase') || text.includes('table') || text.includes('schema');
    if (involvesDb) {
      const touchedDb = (evidence.changed_files ?? []).some(f => f.includes('supabase/migrations/') || f.includes('schema') || f.includes('database'));
      if (!touchedDb) {
        return rejected(item, 'core item requires database/schema changes, but no migration or schema files were touched. Create Supabase migrations or schema definitions.');
      }
    }

    if (evidence.feature_coverage && evidence.feature_coverage.ok === false) {
      const kr = (evidence.feature_coverage.kind_requirements ?? []).filter((k) => !k.satisfied);
      const reason = kr.length
        ? `feature coverage failed — ${kr.map((k) => `${k.kind}:${k.requirement}`).join(', ')}`
        : 'feature coverage failed — declared touches/routes missing on disk';
      return rejected(item, reason);
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

function judgeDoc(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  const calls = toolCalls(evidence);
  if (!calls.some((c) => /lint|markdown|remark/i.test(c.name))) {
    return rejected(item, 'doc judge requires a lint/markdown tool call in evidence');
  }
  return matchOrEscalate(item, evidence);
}

function judgeSlides(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  const calls = toolCalls(evidence);
  if (!calls.some((c) => /screenshot|capture|reveal|spectacle/i.test(c.name))) {
    return rejected(item, 'slides judge requires per-slide screenshot evidence');
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
  if (!hasToolCall(evidence, (c) => /curl|fetch|http|test/i.test(c.name))) {
    return rejected(item, 'backend judge requires an HTTP probe or test run');
  }
  if (isTier(item, 'core')) {
    if (!validateAcceptance(item.acceptance).has_any_executable) {
      return rejected(item, 'backend core item has narrative-only acceptance — add a concrete anchor (route/verb/status)');
    }
    
    // TDD Assertion: Core items must have passing tests
    const hasPassingTests = evidence.tests?.some((t) => t.exit_code === 0 && t.ran_after_changes) ?? false;
    if (!hasPassingTests) {
      return rejected(item, 'backend core item requires successful test evidence — write and run Jest tests before claiming done');
    }

    const text = `${item.title} ${item.acceptance?.join(' ') || ''}`.toLowerCase();
    const involvesDb = item.kind === 'crud' || text.includes('database') || text.includes('supabase') || text.includes('table') || text.includes('schema');
    if (involvesDb) {
      const touchedDb = (evidence.changed_files ?? []).some(f => f.includes('supabase/migrations/') || f.includes('schema') || f.includes('database'));
      if (!touchedDb) {
        return rejected(item, 'backend core item requires database/schema changes, but no migration or schema files were touched. Create Supabase migrations or schema definitions.');
      }
    }

    if (evidence.feature_coverage && evidence.feature_coverage.ok === false) {
      const kr = (evidence.feature_coverage.kind_requirements ?? []).filter((k) => !k.satisfied);
      const reason = kr.length
        ? `backend feature coverage failed — ${kr.map((k) => `${k.kind}:${k.requirement}`).join(', ')}`
        : 'backend feature coverage failed — declared api route handler missing or incomplete';
      return rejected(item, reason);
    }
    // Soft runtime check: at least one successful 2xx/3xx runtime tool call.
    const anyRuntimeOk = toolCalls(evidence).some((c) => /^curl\s/.test(c.name) && c.ok);
    if (!anyRuntimeOk) {
      return rejected(item, 'backend core item needs at least one successful HTTP probe against the shipped route');
    }
  }
  return matchOrEscalate(item, evidence);
}

function judgeTask(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  if (toolCalls(evidence).length === 0) {
    return rejected(item, 'task judge requires at least one tool-call');
  }
  return matchOrEscalate(item, evidence);
}

function judgeAutomation(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  if (!hasToolCall(evidence, (c) => /run|execute|cron|schedule|webhook/i.test(c.name))) {
    return rejected(item, 'automation judge requires a runtime invocation');
  }
  return matchOrEscalate(item, evidence);
}

function rejected(item: BacklogItem, reason: string): JudgeResult {
  return {
    verdict: 'rejected',
    reason,
    matched_acceptance: [],
    unmatched_acceptance: defaultUnmatched(item),
  };
}

function matchOrEscalate(item: BacklogItem, evidence: EvidenceRecord): JudgeResult {
  const { matched, unmatched } = matchAcceptanceByKeywords(item.acceptance ?? [], evidenceHaystack(evidence));
  if (unmatched.length === 0) {
    return { verdict: 'approved', reason: 'all acceptance entries matched in evidence', matched_acceptance: matched, unmatched_acceptance: [] };
  }
  if ((item.attempts ?? 0) >= 3) {
    return {
      verdict: 'escalate',
      reason: `attempts=${item.attempts ?? 0} with ${unmatched.length} unmatched acceptance — escalating to self-heal/needs_review`,
      matched_acceptance: matched,
      unmatched_acceptance: unmatched,
    };
  }
  return {
    verdict: 'rejected',
    reason: `${unmatched.length}/${item.acceptance?.length ?? 0} acceptance entries lack matching evidence`,
    matched_acceptance: matched,
    unmatched_acceptance: unmatched,
  };
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
  return null;
}

export function runJudge(ctx: ArchetypeContext): JudgeResult {
  const override = judgeOverrideForKind(ctx.item.kind);
  const fn = override ?? JUDGE_BY_FLOW[ctx.flow] ?? judgeTask;
  return fn(ctx.item, ctx.evidence);
}
