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

function normalizeRoute(route: string): string {
  if (!route.startsWith('/')) return `/${route}`;
  return route;
}

function routeFilename(route: string, viewport: string): string {
  const safeRoute = route.replace(/^\/+/, '').replace(/[^a-z0-9-_]/gi, '_') || 'root';
  return `${safeRoute}__${viewport}__${Date.now()}.png`;
}

async function uploadScreenshot(
  buffer: Buffer,
  params: { requirementId?: string; stepOrder: number; route: string; viewport: string },
): Promise<{ url?: string; storage_path?: string; error?: string }> {
  const bucket = process.env.SUPABASE_BUCKET || 'workspaces';
  const repoUrl = process.env.REPOSITORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const repoKey = process.env.REPOSITORY_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Required in production (e.g. Vercel) for uploads; without them all probes return 0 screenshots.
  if (!repoUrl || !repoKey) {
    return { error: 'SUPABASE_* env vars missing — screenshot not uploaded' };
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

function generateSandboxScript(params: {
  port: number;
  viewports: VisualProbeViewport[];
  pageRoutes: string[];
  pageTimeoutMs: number;
  requirementId?: string;
  stepOrder: number;
  repoUrl: string;
  repoKey: string;
  bucket: string;
}): string {
  return `
const fs = require('fs');

// Apply Lambda shim for Vercel Sandbox (Amazon Linux 2023) BEFORE requiring sparticuz
const major = parseInt(process.versions.node.split('.')[0] || '20', 10);
if (major >= 22 || major === 21) {
  process.env.AWS_LAMBDA_JS_RUNTIME = process.env.AWS_LAMBDA_JS_RUNTIME || 'nodejs22.x';
  process.env.AWS_EXECUTION_ENV = process.env.AWS_EXECUTION_ENV || 'AWS_Lambda_nodejs22.x';
} else if (major >= 20) {
  process.env.AWS_LAMBDA_JS_RUNTIME = process.env.AWS_LAMBDA_JS_RUNTIME || 'nodejs20.x';
  process.env.AWS_EXECUTION_ENV = process.env.AWS_EXECUTION_ENV || 'AWS_Lambda_nodejs20.x';
} else {
  process.env.AWS_LAMBDA_JS_RUNTIME = process.env.AWS_LAMBDA_JS_RUNTIME || 'nodejs18.x';
  process.env.AWS_EXECUTION_ENV = process.env.AWS_EXECUTION_ENV || 'AWS_Lambda_nodejs18.x';
}

// Clear stale binary if extraction failed previously
if (fs.existsSync('/tmp/chromium')) {
  if (!fs.existsSync('/tmp/al2023/lib/libnss3.so') && !fs.existsSync('/tmp/al2/lib/libnss3.so')) {
    try { fs.unlinkSync('/tmp/chromium'); } catch (e) {}
  }
}

const puppeteer = require('puppeteer-core');
let chromium = require('@sparticuz/chromium');
if (chromium.default) chromium = chromium.default;

const PORT = ${params.port};
const VIEWPORTS = ${JSON.stringify(params.viewports)};
const ROUTES = ${JSON.stringify(params.pageRoutes)};
const TIMEOUT_MS = ${params.pageTimeoutMs};
const REQ_ID = ${JSON.stringify(params.requirementId || 'unknown')};
const STEP_ORDER = ${params.stepOrder};
const REPO_URL = ${JSON.stringify(params.repoUrl)};
const REPO_KEY = ${JSON.stringify(params.repoKey)};
const BUCKET = ${JSON.stringify(params.bucket)};

const consoleEntries = [];
const pageErrors = [];
const failedRequests = [];
const screenshots = [];

function routeFilename(route, viewport) {
  const safeRoute = route.replace(/^\\/+/, '').replace(/[^a-z0-9-_]/gi, '_') || 'root';
  return \`\${safeRoute}__\${viewport}__\${Date.now()}.png\`;
}

async function uploadScreenshot(buffer, route, viewport) {
  const filename = routeFilename(route, viewport);
  const ridFolder = REQ_ID ? \`req-\${REQ_ID}\` : 'req-unknown';
  const storagePath = \`probe-screenshots/\${ridFolder}/step-\${STEP_ORDER}/\${filename}\`;

  const url = \`\${REPO_URL}/storage/v1/object/\${BUCKET}/\${storagePath}\`;
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${REPO_KEY}\`,
        'apikey': REPO_KEY,
        'Content-Type': 'image/png'
      },
      body: buffer
    });
    
    if (!res.ok) {
      const text = await res.text();
      return { error: \`Upload failed: \${res.status} \${text}\` };
    }
    
    const publicUrl = \`\${REPO_URL}/storage/v1/object/public/\${BUCKET}/\${storagePath}\`;
    return { url: publicUrl, storage_path: storagePath };
  } catch (e) {
    return { error: e.message };
  }
}

async function run() {
  let browser;
  try {
    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--disable-dev-shm-usage',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(TIMEOUT_MS);
    page.setDefaultTimeout(TIMEOUT_MS);

    for (const viewport of VIEWPORTS) {
      for (const route of ROUTES) {
        const safeRoute = route.startsWith('/') ? route : '/' + route;
        const target = \`http://127.0.0.1:\${PORT}\${safeRoute}\`;

        try {
          await page.setViewport({
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: viewport.deviceScaleFactor || 1,
            isMobile: !!viewport.isMobile,
          });
        } catch (e) {}

        page.removeAllListeners('console');
        page.removeAllListeners('pageerror');
        page.removeAllListeners('requestfailed');
        page.removeAllListeners('response');

        page.on('console', (msg) => {
          const type = msg.type();
          const levelMap = { log: 'log', info: 'info', warn: 'warn', warning: 'warn', error: 'error', debug: 'debug', verbose: 'debug' };
          const loc = msg.location();
          consoleEntries.push({
            level: levelMap[type] || 'log',
            text: msg.text().slice(0, 600),
            source: loc?.url ? \`\${loc.url}:\${loc.lineNumber || 0}\` : undefined,
            route: safeRoute,
            viewport: viewport.name,
          });
        });

        page.on('pageerror', (err) => {
          pageErrors.push({
            message: err.message.slice(0, 400),
            stack_tail: err.stack ? err.stack.split('\\n').slice(-3).join('\\n').slice(0, 400) : undefined,
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
          if (res.status() >= 400) {
            failedRequests.push({
              url: res.url().slice(0, 300),
              status: res.status(),
              route: safeRoute,
              viewport: viewport.name,
            });
          }
        });

        let responseStatus = 0;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const resp = await page.goto(target, { waitUntil: 'load', timeout: TIMEOUT_MS });
            responseStatus = resp?.status() || 0;
            if (responseStatus === 502 || responseStatus === 503 || responseStatus === 504) {
              if (attempt < 3) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
              }
            }
            break;
          } catch (e) {
            if (attempt < 3 && (e.message.includes('ERR_CONNECTION_REFUSED') || e.message.includes('ERR_NAME_NOT_RESOLVED') || e.message.includes('Timeout'))) {
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            failedRequests.push({
              url: target,
              failure: \`goto: \${e.message.slice(0, 200)}\`,
              route: safeRoute,
              viewport: viewport.name,
            });
            if (!e.message.toLowerCase().includes('timeout')) {
              break; // Fatal error, but we'll still try to screenshot
            }
            break;
          }
        }

        await new Promise(r => setTimeout(r, 2000)); // Hydration wait

        try {
          const buf = await page.screenshot({ type: 'png', fullPage: true });
          if (buf && buf.length > 0) {
            const up = await uploadScreenshot(buf, safeRoute, viewport.name);
            if (up.url) {
              screenshots.push({ route: safeRoute, viewport: viewport.name, url: up.url, storage_path: up.storage_path });
            } else {
              console.error(\`[VisualProbe] Upload failed for \${safeRoute}: \${up.error}\`);
            }
          }
        } catch (e) {
          console.error(\`[VisualProbe] Screenshot failed for \${safeRoute}: \${e.message}\`);
        }
      }
    }
  } catch (e) {
    console.error(\`[VisualProbe] Fatal error: \${e.message}\`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    
    // Output the results as JSON
    console.log(JSON.stringify({
      screenshots,
      consoleEntries,
      pageErrors,
      failedRequests
    }));
  }
}

run();
`;
}

export async function runVisualProbe(params: VisualProbeParams): Promise<VisualProbeResult> {
  const started = Date.now();
  const port = params.port ?? SandboxService.VISUAL_PROBE_PORT;
  const viewports = params.viewports && params.viewports.length ? params.viewports : DEFAULT_VIEWPORTS;
  const pageTimeoutMs = params.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT;
  const pageRoutes = Array.from(new Set(params.pageRoutes.map(normalizeRoute))).slice(0, 12);

  const { sandbox } = params;
  const wd = SandboxService.WORK_DIR;
  
  // Check if puppeteer-core is installed in the sandbox (/tmp)
  const checkCmd = `cd /tmp && npm ls puppeteer-core > /dev/null 2>&1 || echo "NOT_INSTALLED"`;
  const checkRes = await sandbox.runCommand('sh', ['-c', checkCmd]);
  const checkOut = await checkRes.stdout().catch(() => '');
  
  if (checkOut.includes('NOT_INSTALLED')) {
    console.log('[VisualProbe] Installing puppeteer-core and @sparticuz/chromium in sandbox /tmp...');
    // Install in /tmp to avoid dirtying the user's package.json
    await sandbox.runCommand('sh', ['-c', 'cd /tmp && npm init -y && npm install puppeteer-core @sparticuz/chromium --no-save']);
    
    // Debug: Check OS and install deps if possible
    await sandbox.runCommand('sh', ['-c', 'cat /etc/os-release || true']);
    await sandbox.runCommand('sh', ['-c', 'yum install -y nss nspr || apt-get update && apt-get install -y libnss3 libnspr4 || true']);
  }

  const bucket = process.env.SUPABASE_BUCKET || 'workspaces';
  const repoUrl = process.env.REPOSITORY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const repoKey = process.env.REPOSITORY_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const scriptContent = generateSandboxScript({
    port,
    viewports,
    pageRoutes: pageRoutes.length > 0 ? pageRoutes : ['/'],
    pageTimeoutMs,
    requirementId: params.requirementId,
    stepOrder: params.stepOrder,
    repoUrl: repoUrl || '',
    repoKey: repoKey || '',
    bucket
  });

  const scriptPath = '/tmp/visual-probe.js';
  await sandbox.writeFiles([{ path: scriptPath, content: scriptContent }]);

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

  let consoleEntries: ConsoleSignalEntry[] = [];
  let pageErrors: ConsoleSignal['page_errors'] = [];
  let failedRequests: ConsoleSignal['failed_requests'] = [];
  let screenshots: VisualProbeScreenshot[] = [];

  let scriptStderr = '';
  try {
    const r = await sandbox.runCommand('sh', ['-c', `cd /tmp && node ${scriptPath}`]);
    const out = await r.stdout().catch(() => '');
    const err = await r.stderr().catch(() => '');
    scriptStderr = err.trim();
    
    if (scriptStderr.length > 0) {
      console.warn(`[VisualProbe] script stderr: ${scriptStderr}`);
    }

    if (r.exitCode !== 0) {
      throw new Error(`Script exited with code ${r.exitCode}. stderr: ${err}`);
    }

    // Parse the JSON output from the script
    // The script outputs the JSON on the last line
    const lines = out.trim().split('\n');
    const jsonLine = lines[lines.length - 1];
    
    try {
      const parsed = JSON.parse(jsonLine);
      screenshots = parsed.screenshots || [];
      consoleEntries = parsed.consoleEntries || [];
      pageErrors = parsed.pageErrors || [];
      failedRequests = parsed.failedRequests || [];
    } catch (e) {
      console.error(`[VisualProbe] Failed to parse script output: ${out.slice(-500)}`);
      throw new Error('Failed to parse script output');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const fullError = `visual probe crashed: ${msg}\nStderr: ${scriptStderr}`;
    console.warn(`[VisualProbe] ${fullError}`);
    return {
      ok: false,
      duration_ms: Date.now() - started,
      screenshots,
      console: buildConsoleSignal(consoleEntries, pageErrors, failedRequests),
      visual_raw: { ok: false, pass: false, defects: [], screenshots: [] },
      base_url: baseUrl,
      error: fullError,
    };
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
    error: screenshots.length === 0 ? `0 screenshots captured. Stderr: ${scriptStderr}` : undefined,
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
