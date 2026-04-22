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
  return { sha: evidence.commit_sha, files: [] };
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
  const onlyDocs = c.files.length > 0 && c.files.every((f) => /\.md$|^evidence\/|^progress\.md$/.test(f));
  if (onlyDocs) {
    out.push({
      rule: 'admin-only-commit',
      severity: 'major',
      fix_hint: 'Commit touches only docs / evidence. Producer must ship code changes for kind != "report" items.',
    });
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

function matchAcceptanceByKeywords(
  acceptance: string[],
  haystacks: string[],
): { matched: string[]; unmatched: string[] } {
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const a of acceptance) {
    const tokens = a
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4);
    if (tokens.length === 0) {
      unmatched.push(a);
      continue;
    }
    const hit = haystacks.some((hay) => {
      const lower = hay.toLowerCase();
      return tokens.every((t) => lower.includes(t));
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
