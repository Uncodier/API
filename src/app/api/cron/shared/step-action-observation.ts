import { createHash } from 'node:crypto';
import { buildToolActionKey } from './loop-detectors';
import { sanitizeRuntimeLog } from './runtime-log-context';
import { normalizeToolOperationResult, type ToolOperationOutcome } from '@/lib/services/tool-operation-result';

export const ACTION_OBSERVATION_EVENT = 'cron_infra_action_observation';
export interface StepActionObservation {
  version: 1;
  observation_id: string;
  action_digest: string;
  tool_name: string;
  state_before?: string;
  state_after?: string;
  result_digest: string;
  outcome: ToolOperationOutcome;
  complete: boolean;
  excerpt: string;
}

const READ_TOOLS = new Set([
  'sandbox_read_file', 'sandbox_read_files', 'sandbox_read_large_file',
]);
const HASH = /^[a-f0-9]{64}$/;
const VOLATILE_RESULT_KEYS = new Set(['duration_ms', 'durationMs', 'captured_at', 'timestamp', 'elapsed_ms']);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Recovery or a new authorization generation is a different observation state,
 * even when the restored repository has identical bytes. */
export function actionStateFingerprint(workspace: string | null | undefined, sandboxId: string, generation: number): string | undefined {
  return workspace && HASH.test(workspace) && sandboxId && Number.isSafeInteger(generation)
    ? digest(JSON.stringify([workspace, sandboxId, generation])) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Only local observations are comparable to a workspace fingerprint. Never
 * infer that browser/API/deployment/background state is unchanged from Git. */
export function observableAction(name: string, rawArgs: unknown): {
  name: string; digest: string; readOnly: boolean; paths?: string[];
} | undefined {
  let args = record(rawArgs) || {};
  if (name === 'tools') {
    if (args.action !== 'call' || typeof args.name !== 'string') return undefined;
    name = args.name;
    const nested = record(args.args);
    if (!nested) return undefined;
    args = nested;
  }
  const readOnly = READ_TOOLS.has(name);
  if (!readOnly && name !== 'sandbox_run_tests' && name !== 'sandbox_run_command') return undefined;
  let localPaths: string[] | undefined;
  if (readOnly) {
    const paths = name === 'sandbox_read_files' ? args.paths : [args.path];
    // A build fingerprint does not describe /tmp, logs, node_modules, ignored
    // evidence, repository status or remote data. Do not block their retrieval.
    if (!Array.isArray(paths) || !paths.length || paths.length > 12 || !paths.every(path => {
      if (typeof path !== 'string') return false;
      const relative = path.replace(/^\/vercel\/sandbox\//, '').replace(/^\.\//, '');
      return !/[\x00-\x1f]/.test(relative) && !relative.split('/').includes('..') && /^(?:src\/|tests?\/|supabase\/migrations\/|package(?:-lock)?\.json$|tsconfig\.json$)/.test(relative);
    })) return undefined;
    localPaths = paths.map(path => `/vercel/sandbox/${path.replace(/^\/vercel\/sandbox\//, '').replace(/^\.\//, '')}`);
  }
  if (name === 'sandbox_run_command' || name === 'sandbox_run_tests') {
    const rawCommand = typeof args.command === 'string' ? args.command : '';
    if (/[\r\n\t]/.test(rawCommand) || (args.args !== undefined && !Array.isArray(args.args))) return undefined;
    const command = rawCommand.trim();
    const argv: unknown[] = Array.isArray(args.args) ? args.args : [];
    if (!argv.every(arg => typeof arg === 'string' && /^[\w./:@=+-]+$/.test(arg))) return undefined;
    const tokens = [...command.split(/[ \t]+/), ...argv] as string[];
    const full = tokens.join(' ');
    // No shell operators, quotes, env prefixes, installs, servers or arbitrary
    // mutations. Only normalize whitespace for this simple direct test grammar.
    if (!/^[\w ./:@=+-]+$/.test(full) ||
        !/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w.-]+)?|(?:jest|vitest|mocha)(?:\s+run)?|node\s+--test)(?:\s|$)/.test(full)) return undefined;
    args = { ...args, command: tokens };
    delete args.args;
  }
  return { name, digest: digest(buildToolActionKey(name, args)), readOnly, ...(localPaths ? { paths: localPaths } : {}) };
}

function stableResult(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[depth limit]';
  if (Array.isArray(value)) return value.map(entry => stableResult(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => depth > 1 || !VOLATILE_RESULT_KEYS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, stableResult(entry, depth + 1)]));
}

/** Partial output must remain explicitly unknown for repetition enforcement. */
export function resultIsPartial(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === 'string') {
    const parsed = record(value);
    return parsed ? resultIsPartial(parsed, depth + 1)
      : /\[truncated|…\(truncated\)|\.\.\.\s*\[TRUNCATED/i.test(value);
  }
  if (Array.isArray(value)) return value.some(entry => resultIsPartial(entry, depth + 1));
  const obj = record(value);
  if (!obj) return false;
  if (obj.truncated === true || obj.is_partial === true || obj.has_more === true || obj.executed === false ||
      obj.exitCode === null || obj.exit_code === null ||
      obj.running === true || obj.status === 'running' || obj.status === 'skipped') return true;
  return Object.values(obj).some(entry => resultIsPartial(entry, depth + 1));
}

export function makeActionObservation(params: {
  eventId: string; name: string; args: unknown; result: unknown;
  before?: string | null; after?: string | null; threw?: boolean;
}): StepActionObservation | undefined {
  const action = observableAction(params.name, params.args);
  if (!action) return undefined;
  let serialized = '';
  let retained = true;
  try { serialized = JSON.stringify(stableResult(params.result)) ?? ''; } catch { retained = false; }
  // Bound CPU/storage comparison; no digest of an incomplete prefix is evidence.
  if (serialized.length > 256_000) retained = false;
  if (!retained) serialized = '[result unavailable for comparison — retrieve original tool log]';
  const normalized = normalizeToolOperationResult(params.result);
  return {
    version: 1, observation_id: digest(params.eventId), action_digest: action.digest,
    tool_name: action.name,
    ...(params.before && HASH.test(params.before) ? { state_before: params.before } : {}),
    ...(params.after && HASH.test(params.after) ? { state_after: params.after } : {}),
    result_digest: digest(serialized),
    outcome: params.threw || !retained ? 'unknown' : normalized.outcome,
    complete: retained && !params.threw && !!serialized && !resultIsPartial(params.result),
    // Restore escaped newlines only in the human excerpt, never in the digest.
    // Otherwise header redaction would consume the rest of a one-line JSON log.
    excerpt: sanitizeRuntimeLog(serialized.replace(/\\n/g, '\n')).slice(-1_000),
  };
}

export function parseActionObservation(value: unknown): StepActionObservation | undefined {
  const obj = record(value);
  if (!obj || obj.version !== 1 || typeof obj.observation_id !== 'string' || !HASH.test(obj.observation_id) ||
      typeof obj.action_digest !== 'string' || !HASH.test(obj.action_digest) ||
      typeof obj.result_digest !== 'string' || !HASH.test(obj.result_digest) ||
      typeof obj.tool_name !== 'string' || obj.tool_name.length > 100 ||
      !['passed', 'failed', 'unknown'].includes(String(obj.outcome)) || typeof obj.complete !== 'boolean' ||
      typeof obj.excerpt !== 'string' || obj.excerpt.length > 1_000 ||
      (obj.state_before !== undefined && (typeof obj.state_before !== 'string' || !HASH.test(obj.state_before))) ||
      (obj.state_after !== undefined && (typeof obj.state_after !== 'string' || !HASH.test(obj.state_after)))) return undefined;
  return obj as unknown as StepActionObservation;
}

/** Three confirmed equivalent observations, not three calls with the same name.
 * A change, success, unknown result or partial observation breaks the streak. */
export function repeatedActionObservation(
  observations: StepActionObservation[], name: string, args: unknown, currentState?: string | null,
): StepActionObservation | undefined {
  const action = observableAction(name, args);
  if (!action || !currentState || !HASH.test(currentState)) return undefined;
  const seen = new Set<string>();
  const matches = observations.filter(obs => {
    if (seen.has(obs.observation_id)) return false;
    seen.add(obs.observation_id);
    return obs.action_digest === action.digest;
  });
  const latest = matches[0]; // store returns newest first
  if (!latest || latest.outcome === 'unknown' || (!action.readOnly && latest.outcome !== 'failed')) return undefined;
  const comparable = matches.slice(0, 3);
  if (comparable.length !== 3 || !comparable.every(obs => obs.complete &&
      obs.state_before === currentState && obs.state_after === currentState &&
      obs.result_digest === latest.result_digest && obs.outcome === latest.outcome)) return undefined;
  return latest;
}

/** Prompt feedback is advisory: an unchanged workspace cannot establish that a
 * test's external services or time-dependent inputs have not changed. */
export function formatActionObservationFeedback(observations: StepActionObservation[]): string {
  const latest = observations[0];
  if (!latest || latest.outcome !== 'failed' || !latest.complete || !latest.state_before ||
      latest.state_after !== latest.state_before) return '';
  const seen = new Set<string>();
  const same = observations.filter(obs => {
    if (seen.has(obs.observation_id)) return false;
    seen.add(obs.observation_id);
    return obs.action_digest === latest.action_digest;
  }).slice(0, 3);
  if (same.length < 3 || !same.every(obs => obs.complete && obs.outcome === 'failed' &&
      obs.state_before === latest.state_before && obs.state_after === latest.state_after &&
      obs.result_digest === latest.result_digest)) return '';
  return `DIAGNOSTIC OBSERVATION (not a failure verdict): ${latest.tool_name} produced the same recorded failure three times in the same observed state.\n${latest.excerpt}\nInspect the exact source error and choose a targeted check before another correction. A changed workspace or external dependency can justify a retest; Git alone does not describe remote services. Observation IDs are correlation IDs, not instance_history log IDs.`;
}