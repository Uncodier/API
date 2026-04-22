/**
 * Loop detectors — deterministic guards against the three failure patterns
 * the harness keeps hitting:
 *
 *   - Planning loop: lots of tool-calls with almost no writes (the agent
 *     keeps reading / listing / running but never produces a deliverable).
 *   - Action loop: the same command repeated 3+ times; obvious dead-end.
 *   - Admin loop: two consecutive cycles with zero code changes (only
 *     `*.md`, `progress.md`, `evidence/*` touched).
 *
 * Each detector returns a `LoopDetectorVerdict` so the caller can decide
 * what to do (inject a STOP feedback, jump to self-heal, freeze budget,
 * mark item `needs_review`, etc.). The detectors themselves are pure — no
 * I/O, no side effects, no LLM calls.
 */

export type LoopKind = 'planning' | 'action' | 'admin';

export interface LoopDetectorVerdict {
  triggered: boolean;
  kind: LoopKind;
  reason?: string;
  feedback?: string;
  /** Counters useful for logging / cost-envelope debugging. */
  metrics?: Record<string, number>;
}

export interface AssistantToolCallSnapshot {
  /** Tool name as registered (e.g. `sandbox_run_command`, `sandbox_write_file`). */
  name: string;
  /** Optional concrete command used when name is `sandbox_run_command`. */
  command?: string;
  /** Whether the call mutated the workspace (writes / commits / migrations). */
  is_write?: boolean;
}

const PLANNING_TOOLCALL_THRESHOLD = 8;
const PLANNING_WRITE_RATIO = 0.1;
const ACTION_REPEAT_THRESHOLD = 3;
const ACTION_REPEAT_RATIO = 0.6;

const WRITE_TOOL_PATTERNS = [
  /sandbox_write_file/i,
  /sandbox_push_checkpoint/i,
  /sandbox_run_command/i, // `git commit`, `npm install`, etc. classified by command below.
  /requirement_backlog/i,
  /requirement_status/i,
  /platform/i,
];

const READ_ONLY_COMMAND_PREFIXES = ['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'pwd', 'stat'];

function classifyWrite(call: AssistantToolCallSnapshot): boolean {
  if (typeof call.is_write === 'boolean') return call.is_write;
  if (call.name === 'sandbox_run_command' && call.command) {
    const head = call.command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (READ_ONLY_COMMAND_PREFIXES.includes(head)) return false;
    if (head === 'git' && /\b(status|log|diff|branch|show|fetch|remote)\b/.test(call.command)) return false;
    return true;
  }
  return WRITE_TOOL_PATTERNS.some((re) => re.test(call.name));
}

export function detectPlanningLoop(calls: AssistantToolCallSnapshot[]): LoopDetectorVerdict {
  if (calls.length < PLANNING_TOOLCALL_THRESHOLD) {
    return { triggered: false, kind: 'planning' };
  }
  const writes = calls.filter(classifyWrite).length;
  const ratio = writes / calls.length;
  if (ratio >= PLANNING_WRITE_RATIO) {
    return {
      triggered: false,
      kind: 'planning',
      metrics: { tool_calls: calls.length, writes, write_ratio: ratio },
    };
  }
  return {
    triggered: true,
    kind: 'planning',
    reason: `planning loop: ${calls.length} tool-calls with ${(ratio * 100).toFixed(1)}% writes`,
    feedback:
      'STOP: planning loop. Your deliverable this cycle is code changes (sandbox_write_file / git commit / requirement_backlog), not exploration. Pick the next pending backlog item and ship a minimal change.',
    metrics: { tool_calls: calls.length, writes, write_ratio: ratio },
  };
}

export function detectActionLoop(calls: AssistantToolCallSnapshot[]): LoopDetectorVerdict {
  if (calls.length < ACTION_REPEAT_THRESHOLD) {
    return { triggered: false, kind: 'action' };
  }
  const counts = new Map<string, number>();
  for (const c of calls) {
    const key = c.command?.trim() || c.name;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let topKey = '';
  let topCount = 0;
  counts.forEach((v, k) => {
    if (v > topCount) {
      topKey = k;
      topCount = v;
    }
  });
  const ratio = topCount / calls.length;
  if (topCount < ACTION_REPEAT_THRESHOLD || ratio < ACTION_REPEAT_RATIO) {
    return { triggered: false, kind: 'action' };
  }
  return {
    triggered: true,
    kind: 'action',
    reason: `action loop: "${topKey}" repeated ${topCount}/${calls.length} times`,
    feedback: `STOP: action loop. The same command "${topKey}" is failing or no-op ${topCount} times in a row. Change the approach (read the actual error, switch tool, or downgrade scope) instead of retrying.`,
    metrics: { repeats: topCount, total: calls.length, ratio },
  };
}

export interface CycleGitChange {
  files: string[];
}

const ADMIN_FILE_PATTERNS = [
  /\.md$/i,
  /^evidence\//i,
  /^progress\.md$/i,
  /^DECISIONS\.md$/i,
  /^feature_list\.json$/i,
  /^requirement\.spec\.md$/i,
  /^AGENTS\.md$/i,
];

function isAdminOnlyFile(file: string): boolean {
  return ADMIN_FILE_PATTERNS.some((re) => re.test(file));
}

export function detectAdminLoop(history: CycleGitChange[]): LoopDetectorVerdict {
  if (history.length < 2) {
    return { triggered: false, kind: 'admin', metrics: { cycles_inspected: history.length } };
  }
  const lastTwo = history.slice(-2);
  const adminOnly = lastTwo.every((cycle) =>
    cycle.files.length > 0 && cycle.files.every(isAdminOnlyFile),
  );
  if (!adminOnly) {
    return { triggered: false, kind: 'admin', metrics: { cycles_inspected: lastTwo.length } };
  }
  return {
    triggered: true,
    kind: 'admin',
    reason: 'admin loop: 2 consecutive cycles touched only docs / evidence / backlog files',
    feedback:
      'STOP: admin loop. The last two cycles produced no code changes — only docs / evidence updates. Mark the active item needs_review and downgrade its scope on the next cycle.',
    metrics: { cycles_inspected: lastTwo.length },
  };
}
