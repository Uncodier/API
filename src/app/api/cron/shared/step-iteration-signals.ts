/**
 * Aggregates per-step gate signals into a typed object and produces the
 * user-facing retry message the executor sees on the next gate attempt.
 *
 * No sandbox / assistant imports here so this stays workflow-bundle safe.
 */

import type {
  RuntimeApiProbe,
  RuntimePageProbe,
  RuntimeProbeResult,
  RuntimeProbeServerError,
} from './step-runtime-probe';
import type { GitPushFailureKind } from '@/lib/services/git-push-error-triage';

export type GateFailureCategory =
  | 'layout'
  | 'build'
  | 'runtime'
  | 'api'
  | 'console'
  | 'scenario'
  | 'visual'
  | 'origin'
  | 'deploy';

export type BuildSignal = {
  ok: boolean;
  error_tail?: string;
  layout_error?: string;
};

export type RuntimeSignal = {
  ok: boolean;
  port?: number;
  duration_ms?: number;
  startup_error?: string;
  server_errors: RuntimeProbeServerError[];
  server_log_tail?: string;
  pages: RuntimePageProbe[];
};

export type ApiSignal = {
  ok: boolean;
  apis: RuntimeApiProbe[];
};

export type ConsoleSignalEntry = {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  source?: string;
  route?: string;
  viewport?: string;
};

export type ConsoleSignal = {
  ok: boolean;
  entries: ConsoleSignalEntry[];
  page_errors: Array<{ message: string; route?: string; viewport?: string; stack_tail?: string }>;
  failed_requests: Array<{ url: string; status?: number; failure?: string; route?: string; viewport?: string }>;
};

export type ScenarioStepOutcome = {
  index: number;
  action: string;
  ok: boolean;
  error?: string;
  artifacts?: {
    screenshot_url?: string;
    dom_snippet?: string;
  };
};

export type ScenarioOutcome = {
  scenario: string;
  pass: boolean;
  duration_ms: number;
  steps: ScenarioStepOutcome[];
};

export type ScenarioSignal = {
  ok: boolean;
  scenarios: ScenarioOutcome[];
};

export type VisualDefect = {
  category:
    | 'hierarchy'
    | 'spacing'
    | 'typography'
    | 'color_contrast'
    | 'responsive'
    | 'copy'
    | 'state_missing'
    | 'broken_visual';
  severity: 'blocker' | 'major' | 'minor';
  route: string;
  viewport: string;
  description: string;
  fix_hint?: string;
};

export type VisualSignal = {
  ok: boolean;
  pass: boolean;
  summary?: string;
  defects: VisualDefect[];
  screenshots: Array<{ route: string; viewport: string; url: string; dom_snippet?: string }>;
};

export type DeploySignal = {
  previewUrl?: string | null;
  deployState?: string;
  detail?: string;
  buildLogExcerpt?: string | null;
};

/** Origin (git push) gate outcome: full `error` for ops; `errorForAgent` for executor prompts. */
export type OriginSignal = {
  ok: boolean;
  branch?: string;
  /** Full git stderr / message for operators and instance_logs. */
  error?: string;
  /** Short, stable line for the model (from push triage). */
  errorForAgent?: string;
  failureKind?: GitPushFailureKind;
  agentActionable?: boolean;
};

/**
 * Evidence captured at the end of a Consumer turn, BEFORE the Critic runs.
 * Cross-references three independent sources so that free-text claims by the
 * agent cannot pass the Judge without matching tool-call traces:
 *   - tool_calls: list of commands the agent actually ran in this turn.
 *   - gate signals: typed build / runtime / scenario outcomes.
 *   - commit: SHA + files changed in the turn (git diff).
 */
export type EvidenceSignal = {
  schema_version: 1;
  item_id?: string;
  captured_at: string;
  tool_calls: Array<{
    name: string;
    ok: boolean;
    /** Tail of stdout/stderr or response body for matchers. */
    output_tail?: string;
  }>;
  build?: BuildSignal;
  runtime?: RuntimeSignal;
  scenarios?: ScenarioSignal;
  commit?: { sha?: string; files: string[] };
};

/**
 * Coverage signal for the Producer / Coordinator: which backlog items were
 * targeted, completed or regressed in this turn, and whether the requirement
 * advanced a phase. Used by `loop-detectors` to decide if the cycle made
 * meaningful progress (anti admin-loop guard).
 */
export type FeatureCoverageSignal = {
  items_targeted: string[];
  items_completed: string[];
  items_regressed: string[];
  phase_advanced: boolean;
  /** Optional snapshot of `backlog.completion_ratio` after the turn. */
  completion_ratio?: number;
};

export type StepIterationSignals = {
  attempt: number;
  max_attempts: number;
  bucket?: 'build' | 'runtime' | 'visual';
  step: { order: number; title?: string; expected_output?: string };
  build?: BuildSignal;
  runtime?: RuntimeSignal;
  api?: ApiSignal;
  console?: ConsoleSignal;
  scenarios?: ScenarioSignal;
  visual?: VisualSignal;
  origin?: OriginSignal;
  deploy?: DeploySignal;
  categories_failed: GateFailureCategory[];
  top_level_error?: string;
};

function section(title: string, body: string): string {
  return `## ${title}\n${body.trim()}\n`;
}

function formatBuild(s: BuildSignal): string {
  if (!s) return '';
  if (s.ok) return section('BUILD', 'npm run build passed');
  const layout = s.layout_error ? `LAYOUT: ${s.layout_error}\n` : '';
  const err = s.error_tail ? s.error_tail : '(no output captured)';
  return section('BUILD', `${layout}FAILED — fix before anything else.\n---\n${err}\n---`);
}

function formatRuntime(s: RuntimeSignal): string {
  const header = s.ok ? 'runtime OK' : 'runtime FAILED';
  const parts: string[] = [header];
  parts.push(`port=${s.port ?? 'n/a'} duration_ms=${s.duration_ms ?? 'n/a'}`);
  if (s.startup_error) parts.push(`startup_error: ${s.startup_error}`);
  if (s.pages.length) {
    parts.push('pages:');
    for (const p of s.pages) {
      const note = p.http_status === 0 ? ' (no response)' : '';
      parts.push(`  - ${p.path} -> ${p.http_status}${note}${p.ttfb_ms ? ` ttfb=${p.ttfb_ms}ms` : ''}`);
    }
  }
  if (s.server_errors.length) {
    parts.push('server_errors:');
    for (const e of s.server_errors.slice(0, 12)) {
      parts.push(`  - [${e.kind}] ${e.line}`);
    }
  }
  if (s.server_log_tail) {
    parts.push('server_log_tail:');
    parts.push('---');
    parts.push(s.server_log_tail);
    parts.push('---');
  }
  return section('RUNTIME (next start)', parts.join('\n'));
}

function formatApi(s: ApiSignal): string {
  if (!s.apis.length) return section('APIS', 'no API routes probed for this step');
  const lines: string[] = [];
  for (const a of s.apis) {
    const bad = a.http_status >= 400 || a.http_status === 0 ? ' ⚠' : '';
    lines.push(
      `  - ${a.method} ${a.path} -> ${a.http_status}${bad} ct=${a.content_type || 'n/a'} rt=${a.response_time_ms ?? 'n/a'}ms (payload=${a.payload_source})`,
    );
    if (a.body_snippet) {
      const snippet = a.body_snippet.replace(/\s+/g, ' ').trim().slice(0, 240);
      if (snippet) lines.push(`    body: ${snippet}`);
    }
  }
  return section('APIS', lines.join('\n'));
}

function formatConsole(s: ConsoleSignal): string {
  const parts: string[] = [];
  if (s.entries.length) {
    const errors = s.entries.filter((e) => e.level === 'error');
    const warns = s.entries.filter((e) => e.level === 'warn');
    parts.push(`console: ${s.entries.length} entries (${errors.length} errors, ${warns.length} warnings)`);
    for (const e of [...errors, ...warns].slice(0, 12)) {
      const at = e.source ? ` @ ${e.source}` : '';
      const scope = e.route ? ` on ${e.route}${e.viewport ? ` (${e.viewport})` : ''}` : '';
      parts.push(`  - [${e.level}] ${e.text.slice(0, 240)}${at}${scope}`);
    }
  } else {
    parts.push('console: clean');
  }
  if (s.page_errors.length) {
    parts.push(`page_errors: ${s.page_errors.length}`);
    for (const p of s.page_errors.slice(0, 6)) {
      const scope = p.route ? ` on ${p.route}${p.viewport ? ` (${p.viewport})` : ''}` : '';
      parts.push(`  - ${p.message.slice(0, 220)}${scope}`);
      if (p.stack_tail) parts.push(`    ${p.stack_tail.slice(0, 240)}`);
    }
  }
  if (s.failed_requests.length) {
    parts.push(`failed_requests: ${s.failed_requests.length}`);
    for (const r of s.failed_requests.slice(0, 10)) {
      const st = r.status != null ? `${r.status}` : (r.failure || 'failed');
      const scope = r.route ? ` on ${r.route}${r.viewport ? ` (${r.viewport})` : ''}` : '';
      parts.push(`  - ${st} ${r.url.slice(0, 200)}${scope}`);
    }
  }
  return section('CLIENT (browser)', parts.join('\n'));
}

function formatScenarios(s: ScenarioSignal): string {
  if (!s.scenarios.length) return '';
  const parts: string[] = [];
  for (const sc of s.scenarios) {
    parts.push(`${sc.pass ? 'PASS' : 'FAIL'} — ${sc.scenario} (${sc.duration_ms}ms)`);
    for (const st of sc.steps) {
      if (!st.ok) {
        parts.push(`  - step ${st.index} [${st.action}] FAILED: ${(st.error || 'unknown').slice(0, 220)}`);
        if (st.artifacts?.dom_snippet) parts.push(`    dom: ${st.artifacts.dom_snippet.slice(0, 200)}`);
        if (st.artifacts?.screenshot_url) parts.push(`    screenshot: ${st.artifacts.screenshot_url}`);
      }
    }
  }
  return section('E2E SCENARIOS', parts.join('\n'));
}

function formatVisual(s: VisualSignal): string {
  const parts: string[] = [];
  parts.push(`verdict: ${s.pass ? 'PASS' : 'FAIL'}${s.summary ? ` — ${s.summary}` : ''}`);
  if (s.defects.length) {
    parts.push('defects:');
    for (const d of s.defects.slice(0, 20)) {
      parts.push(
        `  - [${d.severity}/${d.category}] ${d.route} (${d.viewport}): ${d.description}${d.fix_hint ? ` | fix: ${d.fix_hint}` : ''}`,
      );
    }
  }
  if (s.screenshots.length) {
    parts.push('screenshots:');
    for (const sh of s.screenshots) {
      parts.push(`  - ${sh.route} (${sh.viewport}): ${sh.url}`);
      if (sh.dom_snippet) {
        parts.push(`    dom_snippet: ${sh.dom_snippet}`);
      }
    }
  }
  return section('VISUAL CRITIC', parts.join('\\n'));
}

function formatDeploy(s: DeploySignal): string {
  const parts: string[] = [];
  if (s.deployState) parts.push(`state=${s.deployState}`);
  if (s.previewUrl) parts.push(`preview_url=${s.previewUrl}`);
  if (s.detail) parts.push(`detail=${s.detail}`);
  if (s.buildLogExcerpt?.trim()) {
    parts.push('vercel_build_log_tail:');
    parts.push('---');
    parts.push(s.buildLogExcerpt.trim());
    parts.push('---');
  }
  return parts.length ? section('DEPLOY (GitHub/Vercel)', parts.join('\n')) : '';
}

export function formatIterationSignals(sig: StepIterationSignals): string {
  const head: string[] = [];
  head.push(
    `# ITERATION FEEDBACK — step ${sig.step.order}${sig.step.title ? ` "${sig.step.title}"` : ''}`,
  );
  head.push(`attempt ${sig.attempt}/${sig.max_attempts}${sig.bucket ? ` (bucket=${sig.bucket})` : ''}`);
  if (sig.step.expected_output) head.push(`expected_output: ${sig.step.expected_output.slice(0, 400)}`);
  if (sig.categories_failed.length) {
    head.push(`categories_failed: ${sig.categories_failed.join(', ')}`);
  }
  if (sig.top_level_error) head.push(`top_level_error: ${sig.top_level_error.slice(0, 500)}`);

  const body: string[] = [head.join('\n'), ''];
  if (sig.build) body.push(formatBuild(sig.build));
  if (sig.runtime) body.push(formatRuntime(sig.runtime));
  if (sig.api) body.push(formatApi(sig.api));
  if (sig.console) body.push(formatConsole(sig.console));
  if (sig.scenarios) body.push(formatScenarios(sig.scenarios));
  if (sig.visual) body.push(formatVisual(sig.visual));
  if (sig.origin && !sig.origin.ok) {
    const line =
      (sig.origin.errorForAgent && sig.origin.errorForAgent.trim()) ||
      (sig.origin.error && sig.origin.error.trim()) ||
      'unknown';
    body.push(section('ORIGIN', `push not verified: ${line}`));
  }
  if (sig.deploy) body.push(formatDeploy(sig.deploy));

  body.push('## NEXT ACTION');
  body.push(
    [
      '1) Fix the FIRST category in `categories_failed` — higher categories often cause later ones.',
      '2) After fixing, re-run npm run build; the gate will re-probe automatically.',
      '3) Only stop when the gate passes (or you receive an explicit human-review instruction).',
    ].join('\n'),
  );

  return body.filter(Boolean).join('\n');
}

export function deriveCategoriesFailed(sig: Omit<StepIterationSignals, 'categories_failed' | 'attempt' | 'max_attempts' | 'step'>): GateFailureCategory[] {
  const cats: GateFailureCategory[] = [];
  if (sig.build?.layout_error) cats.push('layout');
  if (sig.build && !sig.build.ok) cats.push('build');
  if (sig.runtime && !sig.runtime.ok) cats.push('runtime');
  if (sig.api && !sig.api.ok) cats.push('api');
  if (sig.console && !sig.console.ok) cats.push('console');
  if (sig.scenarios && !sig.scenarios.ok) cats.push('scenario');
  if (sig.visual && !sig.visual.ok) cats.push('visual');
  if (sig.origin && !sig.origin.ok) cats.push('origin');
  return cats;
}

/** Best-guess retry bucket from the first failing category. */
export function deriveRetryBucket(categories: GateFailureCategory[]): 'build' | 'runtime' | 'visual' {
  if (categories.includes('build') || categories.includes('layout')) return 'build';
  if (
    categories.includes('runtime') ||
    categories.includes('api') ||
    categories.includes('console') ||
    categories.includes('scenario') ||
    categories.includes('origin') ||
    categories.includes('deploy')
  ) {
    return 'runtime';
  }
  return 'visual';
}

export function buildRuntimeSignalFromProbe(r: {
  ok: boolean;
  port: number;
  duration_ms: number;
  startup_error?: string;
  server_errors: RuntimeProbeServerError[];
  server_log_tail: string;
  pages: RuntimePageProbe[];
}): RuntimeSignal {
  return {
    ok: r.ok,
    port: r.port,
    duration_ms: r.duration_ms,
    startup_error: r.startup_error,
    server_errors: r.server_errors,
    server_log_tail: r.server_log_tail,
    pages: r.pages,
  };
}

export function buildApiSignalFromProbe(r: { apis: RuntimeApiProbe[] }): ApiSignal {
  const ok = r.apis.every((a) => a.http_status > 0 && a.http_status < 500);
  return { ok, apis: r.apis };
}
