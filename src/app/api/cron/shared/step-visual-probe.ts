/**
 * Captures route screenshots and browser-runtime evidence inside the sandbox.
 * The generated Chromium script lives in a separate module to keep this
 * orchestration code small and reviewable.
 */

import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import type {
  ConsoleSignal,
  ConsoleSignalEntry,
  VisualSignal,
} from './step-iteration-signals';
import { generateVisualProbeScript } from './step-visual-probe-script';
import {
  cleanupLocalVisualCaptures,
  persistVisualCaptures,
  resolveVisualStorageConfig,
  type LocalVisualCapture,
} from './visual-screenshot-storage';
import {
  sanitizeTelemetryText,
  sanitizeTelemetryUrl,
} from './step-telemetry-sanitize';
import {
  filterHarnessOwnedTelemetry,
  type HarnessTelemetryScope,
} from './step-visual-telemetry';

export type VisualProbeViewport = {
  name: 'mobile' | 'desktop' | string;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
};

export const DEFAULT_VIEWPORTS: VisualProbeViewport[] = [
  { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false },
];

export type VisualProbeParams = {
  sandbox: Sandbox;
  port?: number;
  pageRoutes: string[];
  viewports?: VisualProbeViewport[];
  requirementId?: string;
  stepOrder: number;
  pageTimeoutMs?: number;
  /** Gate probes use viewport-only captures to keep visual feedback small. */
  fullPage?: boolean;
  imageType?: 'png' | 'jpeg';
  imageQuality?: number;
  hydrationWaitMs?: number;
  /** Routes explicitly expected to redirect to local authentication pages. */
  protectedRoutes?: string[];
};

export type VisualProbeScreenshot = {
  route: string;
  viewport: string;
  url: string;
  storage_path?: string;
  dom_snippet?: string;
};

export type VisualProbeResult = {
  /** Aggregate result: screenshot capture and browser console checks passed. */
  ok: boolean;
  /** Screenshot capture completed independently of browser console health. */
  capture_ok: boolean;
  duration_ms: number;
  screenshots: VisualProbeScreenshot[];
  console: ConsoleSignal;
  visual_raw: VisualSignal;
  base_url: string;
  auth_redirects: Array<{
    route: string;
    viewport: string;
    redirected_to: string;
    expected?: boolean;
  }>;
  error?: string;
};

const DEFAULT_PAGE_TIMEOUT = 10_000;
const MAX_SCREENSHOT_BYTES = 900_000;
const MAX_SCREENSHOTS = 6;
const VISUAL_DEPS_DIRECTORY = '/tmp/visual-probe-deps';
// Keep this Chrome-major pair aligned with package.json for host-side E2E.
const PUPPETEER_CORE_VERSION = '24.35.0';
const CHROMIUM_VERSION = '143.0.0';

function normalizeRoute(route: string): string {
  return route.startsWith('/') ? route : `/${route}`;
}

function normalizeViewports(
  requested: VisualProbeViewport[] | undefined,
): VisualProbeViewport[] {
  const source = requested?.length ? requested : DEFAULT_VIEWPORTS;
  const names = new Set<string>();
  const normalized: VisualProbeViewport[] = [];
  for (const viewport of source) {
    const name = String(viewport.name || '').trim().slice(0, 40);
    if (!name || names.has(name)) continue;
    names.add(name);
    normalized.push({
      name,
      width: Math.max(
        320,
        Math.min(1_920, Math.round(Number(viewport.width) || 1_280)),
      ),
      height: Math.max(
        320,
        Math.min(1_200, Math.round(Number(viewport.height) || 720)),
      ),
      deviceScaleFactor: Math.max(
        1,
        Math.min(2, Number(viewport.deviceScaleFactor) || 1),
      ),
      isMobile: !!viewport.isMobile,
    });
    if (normalized.length === MAX_SCREENSHOTS) break;
  }
  return normalized.length ? normalized : DEFAULT_VIEWPORTS;
}

function emptyConsoleSignal(): ConsoleSignal {
  return { ok: true, entries: [], page_errors: [], failed_requests: [] };
}

function failedProbe(
  started: number,
  baseUrl: string,
  error: string,
  screenshots: VisualProbeScreenshot[] = [],
  consoleSignal: ConsoleSignal = emptyConsoleSignal(),
): VisualProbeResult {
  return {
    ok: false,
    capture_ok: false,
    duration_ms: Date.now() - started,
    screenshots,
    console: consoleSignal,
    visual_raw: {
      ok: false,
      pass: false,
      error,
      defects: [],
      screenshots: [],
    },
    base_url: baseUrl,
    auth_redirects: [],
    error,
  };
}

async function ensureVisualDependencies(sandbox: Sandbox): Promise<void> {
  const check = await sandbox.runCommand('sh', [
    '-c',
    `NODE_PATH="${VISUAL_DEPS_DIRECTORY}/node_modules" node -e "const fs=require('fs'); const version=(name)=>JSON.parse(fs.readFileSync('${VISUAL_DEPS_DIRECTORY}/node_modules/'+name+'/package.json','utf8')).version; if (version('puppeteer-core') !== '${PUPPETEER_CORE_VERSION}' || version('@sparticuz/chromium') !== '${CHROMIUM_VERSION}') process.exit(1); require('puppeteer-core'); require('@sparticuz/chromium')"`,
  ]);
  if (check.exitCode === 0) return;

  console.log('[VisualProbe] Installing pinned browser dependencies in sandbox...');
  const install = await sandbox.runCommand(
    'sh',
    [
      '-c',
      `mkdir -p "${VISUAL_DEPS_DIRECTORY}" && cd "${VISUAL_DEPS_DIRECTORY}" && { test -f package.json || npm init -y >/dev/null; } && npm install puppeteer-core@${PUPPETEER_CORE_VERSION} @sparticuz/chromium@${CHROMIUM_VERSION} --no-save --no-audit --no-fund`,
    ],
    { signal: AbortSignal.timeout(60_000) },
  );
  if (install.exitCode !== 0) {
    const stderr = await install.stderr().catch(() => '');
    throw new Error(
      `Could not install visual browser dependencies: ${stderr.slice(-1_000)}`,
    );
  }
}

export async function runVisualProbe(params: VisualProbeParams): Promise<VisualProbeResult> {
  const started = Date.now();
  const port = params.port ?? SandboxService.VISUAL_PROBE_PORT;
  const viewports = normalizeViewports(params.viewports);
  const pageTimeoutMs = Math.max(
    1_000,
    Math.min(30_000, params.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT),
  );
  const maxRoutes = Math.max(1, Math.floor(MAX_SCREENSHOTS / viewports.length));
  const requestedRoutes = Array.from(
    new Set(params.pageRoutes.map(normalizeRoute)),
  ).slice(0, maxRoutes);
  const pageRoutes = requestedRoutes.length ? requestedRoutes : ['/'];
  const protectedRoutes = Array.from(
    new Set((params.protectedRoutes || []).map(normalizeRoute)),
  ).filter((route) => pageRoutes.includes(route));
  const fullPage = params.fullPage ?? true;
  const imageType = params.imageType ?? 'png';
  const imageQuality = Math.max(30, Math.min(90, params.imageQuality ?? 65));
  const hydrationWaitMs = Math.max(100, Math.min(2_000, params.hydrationWaitMs ?? 2_000));

  let baseUrl: string;
  try {
    baseUrl = params.sandbox.domain(port);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return failedProbe(
      started,
      '',
      `sandbox.domain(${port}) failed — port was not exposed at create time (${message})`,
    );
  }

  const storageConfig = resolveVisualStorageConfig();
  if (!storageConfig) {
    return failedProbe(
      started,
      baseUrl,
      'Visual storage requires a matching Apps/Repository Supabase URL and service-role key',
    );
  }

  await ensureVisualDependencies(params.sandbox);

  const scriptContent = generateVisualProbeScript({
    port,
    viewports,
    pageRoutes,
    pageTimeoutMs,
    fullPage,
    imageType,
    imageQuality,
    hydrationWaitMs,
    maxImageBytes: MAX_SCREENSHOT_BYTES,
    protectedRoutes,
  });
  const scriptPath = '/tmp/visual-probe.js';
  await params.sandbox.writeFiles([{ path: scriptPath, content: scriptContent }]);

  let consoleEntries: ConsoleSignalEntry[] = [];
  let pageErrors: ConsoleSignal['page_errors'] = [];
  let failedRequests: ConsoleSignal['failed_requests'] = [];
  let telemetryDropped: ConsoleSignal['telemetry_dropped'];
  let harnessTrackingScopes: HarnessTelemetryScope[] = [];
  let screenshots: VisualProbeScreenshot[] = [];
  let authRedirects: VisualProbeResult['auth_redirects'] = [];
  let scriptStderr = '';

  try {
    const nodePath = `${VISUAL_DEPS_DIRECTORY}/node_modules`;
    const result = await params.sandbox.runCommand(
      'sh',
      ['-c', `cd /tmp && NODE_PATH="${nodePath}" node ${scriptPath}`],
      { signal: AbortSignal.timeout(60_000) },
    );
    const stdout = await result.stdout().catch(() => '');
    scriptStderr = (await result.stderr().catch(() => '')).trim();
    if (scriptStderr) console.warn(`[VisualProbe] script stderr: ${scriptStderr}`);
    if (result.exitCode !== 0) {
      throw new Error(`Script exited with code ${result.exitCode}. stderr: ${scriptStderr}`);
    }

    const outputLines = stdout.trim().split('\n');
    const jsonLine = outputLines[outputLines.length - 1];
    if (!jsonLine) throw new Error('Visual probe returned no JSON output');
    const parsed = JSON.parse(jsonLine);
    const localCaptures = (parsed.screenshots || []) as LocalVisualCapture[];
    const persisted = await persistVisualCaptures({
      sandbox: params.sandbox,
      captures: localCaptures,
      requirementId: params.requirementId,
      stepOrder: params.stepOrder,
      config: storageConfig,
    });
    screenshots = persisted.screenshots;
    if (persisted.errors.length) {
      scriptStderr = [scriptStderr, ...persisted.errors].filter(Boolean).join('\n');
    }
    consoleEntries = parsed.consoleEntries || [];
    pageErrors = parsed.pageErrors || [];
    failedRequests = parsed.failedRequests || [];
    authRedirects = parsed.authRedirects || [];
    telemetryDropped = parsed.telemetryDropped;
    harnessTrackingScopes = parsed.harnessTrackingScopes || [];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const fullError = `visual probe crashed: ${message}\nStderr: ${scriptStderr}`;
    console.warn(`[VisualProbe] ${fullError}`);
    return failedProbe(
      started,
      baseUrl,
      fullError,
      screenshots,
      buildConsoleSignal(
        consoleEntries,
        pageErrors,
        failedRequests,
        telemetryDropped,
        harnessTrackingScopes,
      ),
    );
  } finally {
    await params.sandbox.fs.rm(scriptPath, { force: true }).catch(() => undefined);
    await cleanupLocalVisualCaptures(params.sandbox);
  }

  const consoleSignal = buildConsoleSignal(
    consoleEntries,
    pageErrors,
    failedRequests,
    telemetryDropped,
    harnessTrackingScopes,
  );
  const expectedScreenshots = pageRoutes.length * viewports.length;
  const completeCapture =
    screenshots.length + authRedirects.length === expectedScreenshots;
  const telemetryTruncated = !!telemetryDropped && Object.values(
    telemetryDropped,
  ).some((count) => count > 0);
  const captureOk = completeCapture;
  const expectedAuthRedirects = authRedirects.filter(
    (redirect) => redirect.expected !== false,
  ).length;
  const captureError = !completeCapture
    ? `${screenshots.length}/${expectedScreenshots} screenshots captured. Stderr: ${scriptStderr}`
    : undefined;
  const consoleError = telemetryTruncated
    ? `Browser telemetry was truncated: ${JSON.stringify(telemetryDropped)}`
    : !consoleSignal.ok
      ? 'Client runtime errors detected. Inspect console entries, page errors, and failed requests, then fix the application-owned errors.'
    : undefined;
  const visualRaw: VisualSignal = {
    ok: captureOk,
    pass: captureOk,
    summary: expectedAuthRedirects
      ? `${expectedAuthRedirects} protected route capture(s) skipped after an authentication redirect.`
      : undefined,
    error: captureError,
    defects: [],
    auth_redirects: authRedirects,
    screenshots: screenshots.map((screenshot) => ({
      route: screenshot.route,
      viewport: screenshot.viewport,
      url: screenshot.url,
      dom_snippet: screenshot.dom_snippet,
    })),
  };

  return {
    ok: captureOk && consoleSignal.ok,
    capture_ok: captureOk,
    duration_ms: Date.now() - started,
    screenshots,
    console: consoleSignal,
    visual_raw: visualRaw,
    base_url: baseUrl,
    auth_redirects: authRedirects,
    error: captureError || consoleError,
  };
}

function buildConsoleSignal(
  entries: ConsoleSignalEntry[],
  pageErrors: ConsoleSignal['page_errors'],
  failedRequests: ConsoleSignal['failed_requests'],
  telemetryDropped?: ConsoleSignal['telemetry_dropped'],
  harnessTrackingScopes: HarnessTelemetryScope[] = [],
): ConsoleSignal {
  const filtered = filterHarnessOwnedTelemetry({
    entries,
    pageErrors,
    failedRequests,
    ownedScopes: harnessTrackingScopes,
  });
  const safeEntries = filtered.entries.map((entry) => ({
    ...entry,
    text: sanitizeTelemetryText(entry.text),
    source: entry.source ? sanitizeTelemetryUrl(entry.source) : entry.source,
  }));
  const safePageErrors = filtered.pageErrors.map((error) => ({
    ...error,
    message: sanitizeTelemetryText(error.message),
    stack_tail: error.stack_tail
      ? sanitizeTelemetryText(error.stack_tail)
      : error.stack_tail,
  }));
  const safeFailedRequests = filtered.failedRequests.map((request) => ({
    ...request,
    url: sanitizeTelemetryUrl(request.url),
    failure: request.failure
      ? sanitizeTelemetryText(request.failure)
      : request.failure,
  }));
  const hasErrors =
    safeEntries.some((entry) => entry.level === 'error') ||
    safePageErrors.length > 0;
  const blockingResourceTypes = new Set(['document', 'script', 'xhr', 'fetch']);
  const hasBadNetwork = safeFailedRequests.some((request) => {
    const relevant =
      !request.resource_type || blockingResourceTypes.has(request.resource_type);
    return relevant && ((request.status ?? 0) >= 500 || !!request.failure);
  });
  const telemetryTruncated =
    !!telemetryDropped &&
    Object.values(telemetryDropped).some((count) => count > 0);
  return {
    ok: !hasErrors && !hasBadNetwork && !telemetryTruncated,
    entries: safeEntries,
    page_errors: safePageErrors,
    failed_requests: safeFailedRequests,
    telemetry_dropped: telemetryDropped,
  };
}
