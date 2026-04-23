/**
 * Per-step visual probe using puppeteer on the host, pointed at the public
 * tunnel URL of the sandbox (sandbox.domain(VISUAL_PROBE_PORT)). Captures:
 *   - Screenshot per route × viewport
 *   - Full console (log/info/warn/error/debug) entries
 *   - pageerror events + failed network requests
 *   - Runtime metrics (DCL, load, LCP approximation)
 *
 * Does NOT make a visual verdict — that's the visual critic (Phase 3). This
 * probe produces raw evidence only. Screenshots are uploaded to Supabase
 * Storage so the critic (vision model) and retry context can reference them.
 */

import type { Sandbox } from '@vercel/sandbox';
import type { Browser, Page } from 'puppeteer-core';
import { launchPuppeteerForGate } from '@/lib/puppeteer/launch-gate-browser';
import { SandboxService } from '@/lib/services/sandbox-service';
import type {
  ConsoleSignal,
  ConsoleSignalEntry,
  VisualSignal,
} from './step-iteration-signals';

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
  /** Screenshot timeout per page. */
  pageTimeoutMs?: number;
  /** Use existing browser instance (tests); otherwise launches one. */
  browser?: Browser;
};

export type VisualProbeScreenshot = {
  route: string;
  viewport: string;
  url: string;
  storage_path?: string;
};

export type VisualProbeResult = {
  ok: boolean;
  duration_ms: number;
  screenshots: VisualProbeScreenshot[];
  console: ConsoleSignal;
  visual_raw: VisualSignal;
  base_url: string;
  error?: string;
};

const DEFAULT_PAGE_TIMEOUT = 15_000;
const SCREENSHOT_BUCKET_PATH_PREFIX = 'probe-screenshots';

function routeFilename(route: string, viewport: string): string {
  const safeRoute = route.replace(/^\/+/, '').replace(/[^a-z0-9-_]/gi, '_') || 'root';
  return `${safeRoute}__${viewport}__${Date.now()}.png`;
}

async function uploadScreenshot(
  buffer: Buffer,
  params: { requirementId?: string; stepOrder: number; route: string; viewport: string },
): Promise<{ url?: string; storage_path?: string; error?: string }> {
  const bucket = process.env.SUPABASE_BUCKET || 'workspaces';
  const repoUrl = process.env.REPOSITORY_SUPABASE_URL;
  const repoKey = process.env.REPOSITORY_SUPABASE_ANON_KEY;
  // Required in production (e.g. Vercel) for uploads; without them all probes return 0 screenshots.
  if (!repoUrl || !repoKey) {
    return { error: 'REPOSITORY_SUPABASE_* env vars missing — screenshot not uploaded' };
  }
  const { createClient } = await import('@supabase/supabase-js');
  const storageClient = createClient(repoUrl, repoKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ridFolder = params.requirementId ? `req-${params.requirementId}` : 'req-unknown';
  const filename = routeFilename(params.route, params.viewport);
  const storagePath = `${SCREENSHOT_BUCKET_PATH_PREFIX}/${ridFolder}/step-${params.stepOrder}/${filename}`;

  const { error } = await storageClient.storage.from(bucket).upload(storagePath, buffer, {
    contentType: 'image/png',
    upsert: true,
  });
  if (error) {
    return { error: `storage upload failed: ${error.message}` };
  }
  const { data } = storageClient.storage.from(bucket).getPublicUrl(storagePath);
  return { url: data.publicUrl, storage_path: storagePath };
}

function normalizeRoute(route: string): string {
  if (!route.startsWith('/')) return `/${route}`;
  return route;
}

async function probeOnePage(params: {
  page: Page;
  baseUrl: string;
  route: string;
  viewport: VisualProbeViewport;
  pageTimeoutMs: number;
  consoleEntries: ConsoleSignalEntry[];
  pageErrors: ConsoleSignal['page_errors'];
  failedRequests: ConsoleSignal['failed_requests'];
  requirementId?: string;
  stepOrder: number;
}): Promise<VisualProbeScreenshot | null> {
  const {
    page,
    baseUrl,
    route,
    viewport,
    pageTimeoutMs,
    consoleEntries,
    pageErrors,
    failedRequests,
    requirementId,
    stepOrder,
  } = params;

  const safeRoute = normalizeRoute(route);
  const target = `${baseUrl.replace(/\/$/, '')}${safeRoute}`;

  try {
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      isMobile: !!viewport.isMobile,
    });
  } catch {}

  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
  page.removeAllListeners('requestfailed');
  page.removeAllListeners('response');

  page.on('console', (msg) => {
    const type = msg.type();
    const levelMap: Record<string, ConsoleSignalEntry['level']> = {
      log: 'log',
      info: 'info',
      warn: 'warn',
      warning: 'warn',
      error: 'error',
      debug: 'debug',
      verbose: 'debug',
    };
    const level = levelMap[type] || 'log';
    const text = msg.text().slice(0, 600);
    const loc = msg.location();
    consoleEntries.push({
      level,
      text,
      source: loc?.url ? `${loc.url}:${loc.lineNumber ?? 0}` : undefined,
      route: safeRoute,
      viewport: viewport.name,
    });
  });
  page.on('pageerror', (err) => {
    pageErrors.push({
      message: err.message.slice(0, 400),
      stack_tail: err.stack ? err.stack.split('\n').slice(-3).join('\n').slice(0, 400) : undefined,
      route: safeRoute,
      viewport: viewport.name,
    });
  });
  page.on('requestfailed', (req) => {
    failedRequests.push({
      url: req.url().slice(0, 300),
      failure: req.failure()?.errorText,
      route: safeRoute,
      viewport: viewport.name,
    });
  });
  page.on('response', (res) => {
    const status = res.status();
    if (status >= 400) {
      failedRequests.push({
        url: res.url().slice(0, 300),
        status,
        route: safeRoute,
        viewport: viewport.name,
      });
    }
  });

  let responseStatus = 0;
  try {
    const resp = await page.goto(target, { waitUntil: 'networkidle2', timeout: pageTimeoutMs });
    responseStatus = resp?.status() ?? 0;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    failedRequests.push({
      url: target,
      failure: `goto: ${msg.slice(0, 200)}`,
      route: safeRoute,
      viewport: viewport.name,
    });
    return null;
  }

  if (responseStatus >= 400) {
    return null;
  }

  try {
    const buf = (await page.screenshot({ type: 'png', fullPage: true })) as Buffer;
    const up = await uploadScreenshot(buf, {
      requirementId,
      stepOrder,
      route: safeRoute,
      viewport: viewport.name,
    });
    if (up.url) {
      return { route: safeRoute, viewport: viewport.name, url: up.url, storage_path: up.storage_path };
    }
    return null;
  } catch {
    return null;
  }
}

export async function runVisualProbe(params: VisualProbeParams): Promise<VisualProbeResult> {
  const started = Date.now();
  const port = params.port ?? SandboxService.VISUAL_PROBE_PORT;
  const viewports = params.viewports && params.viewports.length ? params.viewports : DEFAULT_VIEWPORTS;
  const pageTimeoutMs = params.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT;
  const pageRoutes = Array.from(new Set(params.pageRoutes.map(normalizeRoute))).slice(0, 12);

  const consoleEntries: ConsoleSignalEntry[] = [];
  const pageErrors: ConsoleSignal['page_errors'] = [];
  const failedRequests: ConsoleSignal['failed_requests'] = [];
  const screenshots: VisualProbeScreenshot[] = [];

  let baseUrl: string;
  try {
    baseUrl = params.sandbox.domain(port);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      duration_ms: Date.now() - started,
      screenshots: [],
      console: { ok: true, entries: [], page_errors: [], failed_requests: [] },
      visual_raw: { ok: false, pass: false, defects: [], screenshots: [] },
      base_url: '',
      error: `sandbox.domain(${port}) failed — port was not exposed at create time (${msg})`,
    };
  }

  let browser: Browser | undefined = params.browser;
  let ownsBrowser = false;
  try {
    if (!browser) {
      browser = await launchPuppeteerForGate();
      ownsBrowser = true;
    }
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(pageTimeoutMs);
    page.setDefaultTimeout(pageTimeoutMs);

    for (const viewport of viewports) {
      for (const route of pageRoutes) {
        const shot = await probeOnePage({
          page,
          baseUrl,
          route,
          viewport,
          pageTimeoutMs,
          consoleEntries,
          pageErrors,
          failedRequests,
          requirementId: params.requirementId,
          stepOrder: params.stepOrder,
        });
        if (shot) screenshots.push(shot);
      }
    }

    await page.close().catch(() => {});
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      duration_ms: Date.now() - started,
      screenshots,
      console: buildConsoleSignal(consoleEntries, pageErrors, failedRequests),
      visual_raw: { ok: false, pass: false, defects: [], screenshots: [] },
      base_url: baseUrl,
      error: `visual probe crashed: ${msg}`,
    };
  } finally {
    if (ownsBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }

  const hasErrors =
    consoleEntries.some((e) => e.level === 'error') ||
    pageErrors.length > 0 ||
    failedRequests.some((r) => (r.status ?? 0) >= 500 || !!r.failure);

  const consoleSignal = buildConsoleSignal(consoleEntries, pageErrors, failedRequests);
  const visualRaw: VisualSignal = {
    ok: screenshots.length > 0,
    pass: screenshots.length > 0 && !hasErrors,
    defects: [],
    screenshots: screenshots.map((s) => ({ route: s.route, viewport: s.viewport, url: s.url })),
  };

  return {
    ok: screenshots.length > 0 && !hasErrors,
    duration_ms: Date.now() - started,
    screenshots,
    console: consoleSignal,
    visual_raw: visualRaw,
    base_url: baseUrl,
  };
}

function buildConsoleSignal(
  entries: ConsoleSignalEntry[],
  pageErrors: ConsoleSignal['page_errors'],
  failedRequests: ConsoleSignal['failed_requests'],
): ConsoleSignal {
  const hasErrors = entries.some((e) => e.level === 'error') || pageErrors.length > 0;
  const hasBadNetwork = failedRequests.some((r) => (r.status ?? 0) >= 500 || !!r.failure);
  return {
    ok: !hasErrors && !hasBadNetwork,
    entries,
    page_errors: pageErrors,
    failed_requests: failedRequests,
  };
}
