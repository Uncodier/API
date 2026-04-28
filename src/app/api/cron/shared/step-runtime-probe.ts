/**
 * Per-step runtime probe: boots `next start` inside the sandbox, hits target
 * page + API routes with curl, captures stdout/stderr to a log file, kills
 * the server, and returns typed signals for the gate + retry context.
 *
 * Must NOT carry 'use step' so sandbox closures survive when invoked from
 * step-git-gate.ts.
 */

import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';

const DEFAULT_PROBE_DURATION_MS = 20_000;
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
};

export type RuntimeProbeServerError = {
  kind:
    | 'module_not_found'
    | 'unhandled_rejection'
    | 'uncaught_exception'
    | 'hydration_mismatch'
    | 'syntax_error'
    | 'type_error'
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
  port?: number;
  /**
   * When true, leaves `next start` running after curl probes finish and writes
   * the PID to /tmp/makinari-server-<port>.pid so the visual probe can reuse
   * the server. Caller MUST invoke stopProbeServer afterwards to avoid
   * leaking processes inside the sandbox.
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
  if (typeof port === 'number' && port > 1024 && port < 65535) return port;
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
    startReadyTimeoutSec,
    pageRoutes,
    apiRoutes,
    resultPath,
    keepServerAlive,
  } = params;
  const lines: string[] = [];
  lines.push(`cd ${wd}`);
  lines.push(`: > ${logPath}`);
  lines.push(`: > ${resultPath}`);
  lines.push(`rm -f ${pidPath}`);
  lines.push(`npx --yes next start -H 0.0.0.0 -p ${port} >> ${logPath} 2>&1 &`);
  lines.push('SERVER_PID=$!');
  lines.push(`echo $SERVER_PID > ${pidPath}`);
  lines.push('READY=0');
  lines.push(`for i in $(seq 1 ${startReadyTimeoutSec}); do`);
  lines.push(`  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/ 2>/dev/null)`);
  lines.push('  if [ -n "$STATUS" ] && [ "$STATUS" != "000" ]; then READY=1; break; fi');
  lines.push('  sleep 1');
  lines.push('done');
  lines.push('echo "READY=$READY" >> ' + resultPath);

  pageRoutes.forEach((route, idx) => {
    const safeRoute = route.startsWith('/') ? route : `/${route}`;
    const url = `http://127.0.0.1:${port}${safeRoute}`;
    lines.push(
      `PAGE_BODY_${idx}=/tmp/mk-page-${idx}.bin`,
    );
    lines.push(
      `PAGE_STATS_${idx}=$(curl -s -o "$PAGE_BODY_${idx}" -w "%{http_code}|%{time_starttransfer}|%{content_type}" ${shellEscape(url)} 2>/dev/null)`,
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
      ? `-d @${api.payloadFile} -H 'content-type: application/json'`
      : '';
    lines.push(
      `API_BODY_${idx}=/tmp/mk-api-${idx}.bin`,
    );
    lines.push(
      `API_STATS_${idx}=$(curl -s -o "$API_BODY_${idx}" -w "%{http_code}|%{time_starttransfer}|%{content_type}" -X ${api.method} ${bodyFlag} ${shellEscape(url)} 2>/dev/null)`,
    );
    lines.push(
      `API_SNIPPET_${idx}=$(head -c ${BODY_SNIPPET_BYTES} "$API_BODY_${idx}" 2>/dev/null | base64 | tr -d '\\n')`,
    );
    lines.push(
      `printf "API|%s|%s|%s|%s\\n" ${shellEscape(safeRoute)} ${shellEscape(api.method)} "$API_STATS_${idx}" "$API_SNIPPET_${idx}" >> ${resultPath}`,
    );
  });

  if (!keepServerAlive) {
    lines.push('kill $SERVER_PID 2>/dev/null || true');
    lines.push('wait $SERVER_PID 2>/dev/null || true');
    lines.push(`rm -f ${pidPath}`);
  }
  lines.push('echo DONE >> ' + resultPath);
  return lines.join('\n');
}

function parseResultLines(raw: string): {
  ready: boolean;
  pages: Array<{ path: string; stats: string; b64: string }>;
  apis: Array<{ path: string; method: string; stats: string; b64: string }>;
} {
  const out = {
    ready: false,
    pages: [] as Array<{ path: string; stats: string; b64: string }>,
    apis: [] as Array<{ path: string; method: string; stats: string; b64: string }>,
  };
  for (const line of raw.split('\n')) {
    if (line.startsWith('READY=')) {
      out.ready = line.slice(6).trim() === '1';
      continue;
    }
    if (line.startsWith('PAGE|')) {
      const [, path, stats, b64] = line.split('|');
      out.pages.push({ path: path || '/', stats: stats || '', b64: b64 || '' });
      continue;
    }
    if (line.startsWith('API|')) {
      const [, path, method, stats, b64] = line.split('|');
      out.apis.push({
        path: path || '/',
        method: method || 'GET',
        stats: stats || '',
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

async function readSandboxFile(sandbox: Sandbox, path: string): Promise<string> {
  try {
    const buf = await sandbox.fs.readFile(path, 'utf8');
    return typeof buf === 'string' ? buf : String(buf ?? '');
  } catch {
    return '';
  }
}

export async function runRuntimeProbe(params: RuntimeProbeParams): Promise<RuntimeProbeResult> {
  const started = Date.now();
  const { sandbox } = params;
  const wd = SandboxService.WORK_DIR;
  const port = pickPort(params.port);
  const logPath = `${PROBE_LOG_PATH_PREFIX}-${port}.log`;
  const pidPath = `${PROBE_PID_PATH_PREFIX}-${port}.pid`;
  const resultPath = `/tmp/makinari-probe-${port}.out`;
  const keepServerAlive = !!params.keepServerAlive;

  const pageRoutes = Array.from(new Set(['/', ...(params.pageRoutes || [])].map((p) => p.trim()).filter(Boolean)));
  const apiRoutes = (params.apiRoutes || []).map((api) => ({
    path: api.path,
    method: (api.method || 'GET') as HttpMethod,
    payload: api.payload,
    payload_source: api.payload_source || (api.payload != null ? 'inferred' : 'none'),
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
    if (a.payload != null) {
      payloadFile = `/tmp/mk-api-payload-${i}.json`;
      await sandbox.writeFiles([{ path: payloadFile, content: JSON.stringify(a.payload) }]).catch(() => {});
    }
    apiWithPayloads.push({ path: a.path, method: a.method, payloadFile, index: i, raw: a });
  }

  const durationMs = params.durationMs ?? DEFAULT_PROBE_DURATION_MS;
  const startReadyTimeoutSec = Math.max(5, Math.min(40, Math.floor(durationMs / 1000)));

  const script = buildProbeScript({
    wd,
    port,
    logPath,
    pidPath,
    startReadyTimeoutSec,
    pageRoutes,
    apiRoutes: apiWithPayloads.map(({ path, method, payloadFile, index }) => ({ path, method, payloadFile, index })),
    resultPath,
    keepServerAlive,
  });

  let startupError: string | undefined;
  try {
    await sandbox.runCommand('sh', ['-c', script]);
  } catch (e: unknown) {
    startupError = e instanceof Error ? e.message : String(e);
  }

  const [serverLogRaw, resultRaw] = await Promise.all([
    readSandboxFile(sandbox, logPath),
    readSandboxFile(sandbox, resultPath),
  ]);

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
        raw?.payload != null
          ? tail(typeof raw.payload === 'string' ? raw.payload : JSON.stringify(raw.payload), 400)
          : undefined,
    };
  });

  if (!parsed.ready) {
    startupError = startupError || 'next start did not respond within the probe window';
  }

  let soft404Detected = false;
  const anyPageFailure = pages.some((p) => {
    if (p.http_status < 200 || p.http_status >= 400 || p.http_status === 0) return true;
    const body = p.body_snippet?.toLowerCase() || '';
    if (body.includes('this page could not be found') || body.includes('application error') || body.includes('404 page not found')) {
      soft404Detected = true;
      return true;
    }
    return false;
  });

  if (soft404Detected && !startupError) {
    startupError = 'Soft 404 or Next.js Error Boundary detected in page response body.';
  }

  const anyApi5xx = apis.some((a) => a.http_status >= 500 || a.http_status === 0);
  const hasBlockingServerError = serverErrors.some((e) =>
    ['module_not_found', 'unhandled_rejection', 'uncaught_exception', 'syntax_error', 'type_error'].includes(e.kind),
  );

  const ok = !startupError && !anyPageFailure && !anyApi5xx && !hasBlockingServerError;

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

/**
 * Compact plain-text summary for log lines / audit messages (not the full
 * structured retry payload — see formatIterationSignals for that).
 */
/**
 * Kill a server that was started by runRuntimeProbe with keepServerAlive: true.
 * Safe to call even if the PID file is missing — returns { killed: false }.
 */
export async function stopProbeServer(
  sandbox: Sandbox,
  port: number,
): Promise<{ killed: boolean }> {
  const pidPath = `${PROBE_PID_PATH_PREFIX}-${port}.pid`;
  const script = [
    `if [ -f ${pidPath} ]; then`,
    `  PID=$(cat ${pidPath} | tr -d '\\n')`,
    `  if [ -n "$PID" ]; then`,
    `    kill $PID 2>/dev/null || true`,
    `    for i in 1 2 3 4 5; do`,
    `      if kill -0 $PID 2>/dev/null; then sleep 1; else break; fi`,
    `    done`,
    `    kill -9 $PID 2>/dev/null || true`,
    `  fi`,
    `  rm -f ${pidPath}`,
    `  echo KILLED`,
    `else`,
    `  echo NO_PID`,
    `fi`,
  ].join('\n');
  try {
    const r = await sandbox.runCommand('sh', ['-c', script]);
    const out = await r.stdout().catch(() => '');
    return { killed: /KILLED/.test(out) };
  } catch {
    return { killed: false };
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
