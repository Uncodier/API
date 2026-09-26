/**
 * Per-step runtime probe: boots `next start` inside the sandbox, hits target
 * page + API routes with curl, captures stdout/stderr to a log file, kills
 * the server, and returns typed signals for the gate + retry context.
 *
 * Must NOT carry 'use step' so sandbox closures survive when invoked from
 * step-git-gate.ts.
 */

import { randomUUID } from 'node:crypto';
import type { Command, Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { runtimeProbeDeadline } from './runtime-probe-deadline';

const DEFAULT_PROBE_DURATION_MS = 20_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const MAX_TOTAL_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const CURL_TIMEOUT_FLAGS = '--connect-timeout 2 --max-time 5';
const SERVER_LOG_TAIL_BYTES = 6_000;
const BODY_SNIPPET_BYTES = 600;
const PROBE_LOG_PATH_PREFIX = '/tmp/makinari-server';
const PROBE_PID_PATH_PREFIX = '/tmp/makinari-server';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export type RuntimePageProbe = {
  path: string;
  http_status: number;
  ttfb_ms?: number;
  content_type?: string;
  body_snippet?: string;
  validation_source?: 'contract' | 'contract_inferred' | 'protected_route' | 'diff' | 'prose' | 'default';
  validation_disposition?: 'pass' | 'hard_fail' | 'unknown' | 'advisory';
  validation_required?: boolean;
};

export type RuntimeApiProbe = {
  path: string;
  method: HttpMethod;
  payload_source: 'inferred' | 'scenario' | 'none';
  http_status: number;
  response_time_ms?: number;
  content_type?: string;
  body_snippet?: string;
  payload_excerpt?: string;
  validation_source?: 'contract' | 'contract_inferred' | 'protected_route' | 'diff' | 'prose' | 'default';
  validation_disposition?: 'pass' | 'hard_fail' | 'unknown' | 'advisory';
  validation_required?: boolean;
};

export type RuntimeProbeServerError = {
  kind:
    | 'module_not_found'
    | 'unhandled_rejection'
    | 'uncaught_exception'
    | 'hydration_mismatch'
    | 'syntax_error'
    | 'type_error'
    | 'warning'
    | 'generic_error'
    | 'econnrefused';
  line: string;
};

export type RuntimeProbeResult = {
  ok: boolean;
  port: number;
  duration_ms: number;
  server_log_tail: string;
  server_errors: RuntimeProbeServerError[];
  pages: RuntimePageProbe[];
  apis: RuntimeApiProbe[];
  startup_error?: string;
  server_log_path: string;
};

export type RuntimeProbeApiTarget = {
  path: string;
  method?: HttpMethod;
  payload?: unknown;
  payload_source?: RuntimeApiProbe['payload_source'];
};

export type RuntimeProbeParams = {
  sandbox: Sandbox;
  pageRoutes?: string[];
  apiRoutes?: RuntimeProbeApiTarget[];
  durationMs?: number;
  /** Total bound for payload writes, startup, curls and evidence reads (default 60s,
   * maximum 120s). Cleanup has an independent <=5s allowance. durationMs remains
   * the startup-readiness window for compatibility.
   */
  totalTimeoutMs?: number;
  signal?: AbortSignal;
  port?: number;
  /**
   * When true, leaves `next start` running after curl probes finish and writes
   * the PID to /tmp/makinari-server-<port>.pid so the visual probe can reuse
   * the server. Caller MUST invoke stopProbeServer afterwards to avoid
    * leaking processes inside the sandbox. Failures/cancellation never retain it;
    * a server-side five-minute lease also bounds a lost caller.
   */
  keepServerAlive?: boolean;
};

function parseServerErrors(log: string): RuntimeProbeServerError[] {
  const out: RuntimeProbeServerError[] = [];
  const lines = log.split('\n');
  const rules: Array<{ kind: RuntimeProbeServerError['kind']; test: RegExp }> = [
    { kind: 'module_not_found', test: /Module not found|Cannot find module/i },
    { kind: 'unhandled_rejection', test: /unhandledRejection|Unhandled promise rejection/i },
    { kind: 'uncaught_exception', test: /uncaughtException/i },
    { kind: 'hydration_mismatch', test: /Hydration failed|text content does not match|did not match/i },
    { kind: 'syntax_error', test: /SyntaxError/ },
    { kind: 'type_error', test: /TypeError:/ },
    { kind: 'warning', test: /\b(?:warn|warning):/i },
    { kind: 'econnrefused', test: /ECONNREFUSED|connect ECONNREFUSED/ },
    { kind: 'generic_error', test: /^\s*Error:/m },
  ];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    for (const rule of rules) {
      if (rule.test.test(line)) {
        const sig = `${rule.kind}::${line.slice(0, 160)}`;
        if (seen.has(sig)) break;
        seen.add(sig);
        out.push({ kind: rule.kind, line: line.slice(0, 280) });
        break;
      }
    }
    if (out.length >= 30) break;
  }
  return out;
}

function tail(text: string, bytes: number): string {
  if (text.length <= bytes) return text;
  return `…(truncated ${text.length - bytes} earlier chars)\n${text.slice(-bytes)}`;
}

function pickPort(port?: number): number {
  if (typeof port === 'number' && Number.isInteger(port) && port > 1024 && port < 65535) return port;
  // Default = SandboxService.VISUAL_PROBE_PORT. Imported lazily to keep this
  // module usable in environments where the sandbox service isn't available.
  return 3000;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildProbeScript(params: {
  wd: string;
  port: number;
  logPath: string;
  pidPath: string;
  publicPidPath: string;
  startReadyTimeoutSec: number;
  pageRoutes: string[];
  apiRoutes: Array<{
    path: string;
    method: HttpMethod;
    payloadFile?: string;
    index: number;
  }>;
  resultPath: string;
  keepServerAlive: boolean;
}): string {
  const {
    wd,
    port,
    logPath,
    pidPath,
    publicPidPath,
    startReadyTimeoutSec,
    pageRoutes,
    apiRoutes,
    resultPath,
    keepServerAlive,
  } = params;
  const lines: string[] = [];
  lines.push('set -eu');
  lines.push(`cd ${shellEscape(wd)}`);
  lines.push('command -v setsid >/dev/null || exit 1');
  lines.push('command -v timeout >/dev/null || exit 1');
  lines.push(`: > ${logPath}`);
  lines.push(`: > ${resultPath}`);
  // Do not download Next via npx, or kill unrelated `next start` processes.
  // setsid owns exactly this server process group, timeout bounds orphaned servers.
  lines.push('SERVER_PID=; KEEP_SERVER=0');
  lines.push('cleanup() {');
  lines.push('  if [ "$KEEP_SERVER" != 1 ] && [ -n "$SERVER_PID" ]; then');
  lines.push('    kill -TERM -"$SERVER_PID" 2>/dev/null || true');
  lines.push('    kill -KILL -"$SERVER_PID" 2>/dev/null || true');
  lines.push(`    rm -f ${pidPath}`);
  lines.push('  fi');
  const tempFiles = [
    ...pageRoutes.map((_, idx) => `${resultPath}-page-${idx}.bin`),
    ...apiRoutes.map((_, idx) => `${resultPath}-api-${idx}.bin`),
    ...apiRoutes.flatMap((a) => a.payloadFile ? [a.payloadFile] : []),
  ];
  lines.push(`  rm -f ${tempFiles.map(shellEscape).join(' ')}`);
  lines.push('}');
  lines.push("trap cleanup EXIT; trap 'exit 143' HUP INT TERM");
  lines.push(`setsid timeout -k 1 300 node node_modules/next/dist/bin/next start -H 0.0.0.0 -p ${port} >> ${logPath} 2>&1 &`);
  lines.push('SERVER_PID=$!');
  lines.push(`echo $SERVER_PID > ${pidPath}`);
  lines.push('READY=0');
  lines.push(`READY_DEADLINE=$(($(date +%s) + ${startReadyTimeoutSec}))`);
  lines.push('while [ "$(date +%s)" -lt "$READY_DEADLINE" ]; do');
  lines.push('  kill -0 "$SERVER_PID" 2>/dev/null || break');
  lines.push(`  STATUS=$(curl -s ${CURL_TIMEOUT_FLAGS} -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/ 2>/dev/null) || STATUS=000`);
  lines.push('  if [ -n "$STATUS" ] && [ "$STATUS" != "000" ]; then READY=1; break; fi');
  lines.push('  sleep 1');
  lines.push('done');
  lines.push('echo "READY=$READY" >> ' + resultPath);
  lines.push('[ "$READY" = 1 ] || exit 1');

  pageRoutes.forEach((route, idx) => {
    const safeRoute = route.startsWith('/') ? route : `/${route}`;
    const url = `http://127.0.0.1:${port}${safeRoute}`;
    lines.push(
      `PAGE_BODY_${idx}=${resultPath}-page-${idx}.bin`,
    );
    lines.push(
      `PAGE_STATS_${idx}=$(curl -s ${CURL_TIMEOUT_FLAGS} -o "$PAGE_BODY_${idx}" -w "%{http_code}|%{time_starttransfer}|%{content_type}" ${shellEscape(url)} 2>/dev/null) || PAGE_STATS_${idx}='000|0|'`,
    );
    lines.push(
      `PAGE_SNIPPET_${idx}=$(head -c ${BODY_SNIPPET_BYTES} "$PAGE_BODY_${idx}" 2>/dev/null | base64 | tr -d '\\n')`,
    );
    lines.push(
      `printf "PAGE|%s|%s|%s\\n" ${shellEscape(safeRoute)} "$PAGE_STATS_${idx}" "$PAGE_SNIPPET_${idx}" >> ${resultPath}`,
    );
  });

  apiRoutes.forEach((api, idx) => {
    const safeRoute = api.path.startsWith('/') ? api.path : `/${api.path}`;
    const url = `http://127.0.0.1:${port}${safeRoute}`;
    const bodyFlag = api.payloadFile
      ? `-d ${shellEscape(`@${api.payloadFile}`)} -H 'content-type: application/json'`
      : '';
    lines.push(
      `API_BODY_${idx}=${resultPath}-api-${idx}.bin`,
    );
    lines.push(
      `API_STATS_${idx}=$(curl -s ${CURL_TIMEOUT_FLAGS} -o "$API_BODY_${idx}" -w "%{http_code}|%{time_starttransfer}|%{content_type}" -X ${shellEscape(api.method)} ${bodyFlag} ${shellEscape(url)} 2>/dev/null) || API_STATS_${idx}='000|0|'`,
    );
    lines.push(
      `API_SNIPPET_${idx}=$(head -c ${BODY_SNIPPET_BYTES} "$API_BODY_${idx}" 2>/dev/null | base64 | tr -d '\\n')`,
    );
    lines.push(
      `printf "API|%s|%s|%s|%s\\n" ${shellEscape(safeRoute)} ${shellEscape(api.method)} "$API_STATS_${idx}" "$API_SNIPPET_${idx}" >> ${resultPath}`,
    );
  });

  if (keepServerAlive) {
    lines.push(`cp ${pidPath} ${publicPidPath}`);
    lines.push('KEEP_SERVER=1');
  }
  lines.push('echo DONE >> ' + resultPath);
  return lines.join('\n');
}

function parseResultLines(raw: string): {
  ready: boolean;
  done: boolean;
  pages: Array<{ path: string; stats: string; b64: string }>;
  apis: Array<{ path: string; method: string; stats: string; b64: string }>;
} {
  const out = {
    ready: false,
    done: false,
    pages: [] as Array<{ path: string; stats: string; b64: string }>,
    apis: [] as Array<{ path: string; method: string; stats: string; b64: string }>,
  };
  for (const line of raw.split('\n')) {
    if (line.trim() === 'DONE') { out.done = true; continue; }
    if (line.startsWith('READY=')) {
      out.ready = line.slice(6).trim() === '1';
      continue;
    }
    if (line.startsWith('PAGE|')) {
      const [, path, code, ttfb, contentType, b64] = line.split('|');
      out.pages.push({ path: path || '/', stats: [code, ttfb, contentType].join('|'), b64: b64 || '' });
      continue;
    }
    if (line.startsWith('API|')) {
      const [, path, method, code, ttfb, contentType, b64] = line.split('|');
      out.apis.push({
        path: path || '/',
        method: method || 'GET',
        stats: [code, ttfb, contentType].join('|'),
        b64: b64 || '',
      });
    }
  }
  return out;
}

function decodeB64(b64: string): string {
  if (!b64) return '';
  try {
    const buf = Buffer.from(b64, 'base64');
    const s = buf.toString('utf8');
    return s.length > BODY_SNIPPET_BYTES ? s.slice(0, BODY_SNIPPET_BYTES) : s;
  } catch {
    return '';
  }
}

function parseStats(stats: string): { status: number; ttfb?: number; contentType?: string } {
  if (!stats) return { status: 0 };
  const [codeRaw, ttfbRaw, ctRaw] = stats.split('|');
  const status = parseInt(codeRaw || '0', 10) || 0;
  const ttfb = ttfbRaw ? Number(ttfbRaw) : undefined;
  return { status, ttfb: ttfb && Number.isFinite(ttfb) ? Math.round(ttfb * 1000) : undefined, contentType: ctRaw || undefined };
}

async function readSandboxFile(sandbox: Sandbox, path: string, signal: AbortSignal): Promise<string> {
  const buf = await sandbox.fs.readFile(path, { encoding: 'utf8', signal });
  return typeof buf === 'string' ? buf : String(buf ?? '');
}

export async function runRuntimeProbe(params: RuntimeProbeParams): Promise<RuntimeProbeResult> {
  const started = Date.now();
  const { sandbox } = params;
  const wd = SandboxService.WORK_DIR;
  const port = pickPort(params.port);
  const probeId = randomUUID();
  const logPath = `${PROBE_LOG_PATH_PREFIX}-${port}.log`;
  const publicPidPath = `${PROBE_PID_PATH_PREFIX}-${port}.pid`;
  const pidPath = `${PROBE_PID_PATH_PREFIX}-${port}-${probeId}.pid`;
  const resultPath = `/tmp/makinari-probe-${port}-${probeId}.out`;
  const keepServerAlive = !!params.keepServerAlive;
  const totalTimeoutMs = typeof params.totalTimeoutMs === 'number' && Number.isFinite(params.totalTimeoutMs)
    ? Math.max(1, Math.min(MAX_TOTAL_TIMEOUT_MS, params.totalTimeoutMs))
    : DEFAULT_TOTAL_TIMEOUT_MS;
  const deadline = runtimeProbeDeadline(totalTimeoutMs, params.signal);

  const pageRoutes = Array.from(new Set(['/', ...(params.pageRoutes || [])].map((p) => p.trim()).filter(Boolean)));
  const apiRoutes = (params.apiRoutes || []).map((api) => ({
    path: api.path,
    method: (api.method || 'GET') as HttpMethod,
    payload: api.payload,
    payload_source: api.payload_source || (api.payload !== undefined ? 'inferred' : 'none'),
  }));

  const apiWithPayloads: Array<{
    path: string;
    method: HttpMethod;
    payloadFile?: string;
    index: number;
    raw: (typeof apiRoutes)[number];
  }> = [];
  for (let i = 0; i < apiRoutes.length; i++) {
    const a = apiRoutes[i];
    let payloadFile: string | undefined;
    if (a.payload !== undefined) {
      payloadFile = `${resultPath}-payload-${i}.json`;
    }
    apiWithPayloads.push({ path: a.path, method: a.method, payloadFile, index: i, raw: a });
  }

  const durationMs = Number.isFinite(params.durationMs) ? params.durationMs! : DEFAULT_PROBE_DURATION_MS;
  const startReadyTimeoutSec = Math.max(5, Math.min(40, Math.floor(durationMs / 1000)));

  const script = buildProbeScript({
    wd,
    port,
    logPath,
    pidPath,
    publicPidPath,
    startReadyTimeoutSec,
    pageRoutes,
    apiRoutes: apiWithPayloads.map(({ path, method, payloadFile, index }) => ({ path, method, payloadFile, index })),
    resultPath,
    keepServerAlive,
  });

  let startupError: string | undefined;
  let command: Command | undefined;
  let commandFinished = false;
  let commandStarted = false;
  let serverLogRaw = '';
  let resultRaw = '';
  try {
    for (const target of apiWithPayloads) {
      if (target.payloadFile) {
        await deadline.run(() => sandbox.writeFiles([{
          path: target.payloadFile!, content: Buffer.from(JSON.stringify(target.raw.payload)),
        }], { signal: deadline.signal }));
      }
    }
    // SDK 3.2.1 RunCommandParams.timeoutMs is enforced by the VM (SIGKILL),
    // including detached commands. AbortSignal bounds transport waits separately.
    command = await deadline.run(() => {
      commandStarted = true;
      return sandbox.runCommand({
        cmd: 'sh', args: ['-c', script], detached: true,
        timeoutMs: deadline.remainingMs(), signal: deadline.signal,
      });
    });
    const finished = await deadline.run(() => command!.wait({ signal: deadline.signal }));
    commandFinished = true;
    if (finished.exitCode !== 0) startupError = `Runtime probe command exited with code ${finished.exitCode}`;
    [serverLogRaw, resultRaw] = await deadline.run(() => Promise.all([
      readSandboxFile(sandbox, logPath, deadline.signal),
      readSandboxFile(sandbox, resultPath, deadline.signal),
    ]));
  } catch (e: unknown) {
    startupError = e instanceof Error ? e.message : String(e);
  }

  const parsed = parseResultLines(resultRaw);
  const logTail = tail(serverLogRaw, SERVER_LOG_TAIL_BYTES);
  const serverErrors = parseServerErrors(serverLogRaw);

  const pages: RuntimePageProbe[] = parsed.pages.map((p) => {
    const stats = parseStats(p.stats);
    return {
      path: p.path,
      http_status: stats.status,
      ttfb_ms: stats.ttfb,
      content_type: stats.contentType,
      body_snippet: decodeB64(p.b64),
    };
  });

  const apis: RuntimeApiProbe[] = parsed.apis.map((a) => {
    const stats = parseStats(a.stats);
    const raw = apiWithPayloads.find((x) => x.raw.path === a.path && x.raw.method === a.method)?.raw;
    return {
      path: a.path,
      method: (a.method as HttpMethod) || 'GET',
      payload_source: raw?.payload_source || 'none',
      http_status: stats.status,
      response_time_ms: stats.ttfb,
      content_type: stats.contentType,
      body_snippet: decodeB64(a.b64),
      payload_excerpt:
        raw?.payload !== undefined
          ? tail(typeof raw.payload === 'string' ? raw.payload : JSON.stringify(raw.payload), 400)
          : undefined,
    };
  });

  if (!parsed.ready) {
    startupError = startupError || 'next start did not respond within the probe window';
  } else if (!parsed.done || pages.length !== pageRoutes.length || apis.length !== apiRoutes.length) {
    startupError = startupError || 'Runtime probe did not finish collecting all route evidence';
  }

  const hasBlockingServerError = serverErrors.some((e) =>
    [
      'module_not_found',
      'unhandled_rejection',
      'uncaught_exception',
      'syntax_error',
      'type_error',
      'hydration_mismatch',
    ].includes(e.kind),
  );
  if (deadline.signal.aborted) {
    startupError ||= String(deadline.signal.reason);
  }

  // Route-level status belongs to step-probe-policy, where explicit contract
  // targets can block while inferred/prose targets stay advisory. This raw
  // probe only owns process startup and process-wide fatal errors.
  const ok = !startupError && !hasBlockingServerError && !deadline.signal.aborted;
  deadline.dispose();
  const cleanupDeadline = runtimeProbeDeadline(CLEANUP_TIMEOUT_MS);
  try {
    await Promise.all([
      command && !commandFinished
        ? cleanupDeadline.run(() => command!.kill('SIGKILL', { abortSignal: cleanupDeadline.signal })).catch(() => {})
        : Promise.resolve(),
      cleanupDeadline.run(async () => {
        const cleanup = [
          ...(commandStarted && (!ok || !keepServerAlive) ? stopServerScript(pidPath, publicPidPath) : []),
          `rm -f ${shellEscape(pidPath)} ${shellEscape(resultPath)} ${shellEscape(resultPath)}-*.bin ${shellEscape(resultPath)}-payload-*.json`,
        ].join('\n');
        await sandbox.runCommand({ cmd: 'sh', args: ['-c', cleanup], timeoutMs: CLEANUP_TIMEOUT_MS - 500, signal: cleanupDeadline.signal });
      }).catch(() => {}),
    ]);
  } finally {
    deadline.dispose();
    cleanupDeadline.dispose();
  }

  return {
    ok,
    port,
    duration_ms: Date.now() - started,
    server_log_tail: logTail,
    server_errors: serverErrors,
    pages,
    apis,
    startup_error: startupError,
    server_log_path: logPath,
  };
}

function stopServerScript(pidPath: string, publicPidPath = pidPath): string[] {
  return [
    `if [ -f ${shellEscape(pidPath)} ]; then`,
    `  PID=$(cat ${shellEscape(pidPath)} | tr -d '\\n')`,
    '  case "$PID" in ""|*[!0-9]*|0|1) echo NO_PID;; *)',
    // Own a whole process group, not just the npx parent while Next keeps running.
    '    kill -TERM -"$PID" 2>/dev/null || true',
    '    kill -KILL -"$PID" 2>/dev/null || true',
    '    kill -KILL "$PID" 2>/dev/null || true',
    '    echo KILLED;;',
    '  esac',
    // Do not remove a newer probe\'s public pointer during old-probe cleanup.
    `  if [ "$(cat ${shellEscape(publicPidPath)} 2>/dev/null)" = "$PID" ]; then rm -f ${shellEscape(publicPidPath)}; fi`,
    `  rm -f ${shellEscape(pidPath)}`,
    'else echo NO_PID; fi',
  ];
}

/**
 * Kill a server that was started by runRuntimeProbe with keepServerAlive: true.
 * Safe to call even if the PID file is missing — returns { killed: false }.
 */
export async function stopProbeServer(
  sandbox: Sandbox,
  port: number,
): Promise<{ killed: boolean }> {
  const pidPath = `${PROBE_PID_PATH_PREFIX}-${pickPort(port)}.pid`;
  const deadline = runtimeProbeDeadline(CLEANUP_TIMEOUT_MS);
  try {
    const r = await deadline.run(() => sandbox.runCommand({
      cmd: 'sh', args: ['-c', stopServerScript(pidPath).join('\n')],
      timeoutMs: CLEANUP_TIMEOUT_MS - 500, signal: deadline.signal,
    }));
    const out = await deadline.run(() => r.stdout({ signal: deadline.signal }));
    return { killed: /KILLED/.test(out) };
  } catch {
    return { killed: false };
  } finally {
    deadline.dispose();
  }
}

export function summarizeRuntimeProbe(r: RuntimeProbeResult): string {
  const parts: string[] = [];
  parts.push(r.ok ? 'runtime OK' : 'runtime FAIL');
  parts.push(`port=${r.port}`);
  if (r.startup_error) parts.push(`startup_error="${r.startup_error.slice(0, 80)}"`);
  if (r.pages.length) {
    parts.push(`pages=${r.pages.map((p) => `${p.path}→${p.http_status}`).join(',')}`);
  }
  if (r.apis.length) {
    parts.push(`apis=${r.apis.map((a) => `${a.method} ${a.path}→${a.http_status}`).join(',')}`);
  }
  if (r.server_errors.length) {
    const kinds = Array.from(new Set(r.server_errors.map((e) => e.kind))).join('|');
    parts.push(`server_errors=${kinds}`);
  }
  return parts.join(' ');
}
