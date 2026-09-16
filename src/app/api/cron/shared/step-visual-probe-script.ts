import type { VisualProbeViewport } from './step-visual-probe';
import { HARNESS_TRACKING_SCRIPT_URL } from './step-visual-telemetry';

export interface VisualProbeScriptParams {
  port: number;
  viewports: VisualProbeViewport[];
  pageRoutes: string[];
  pageTimeoutMs: number;
  fullPage: boolean;
  imageType: 'png' | 'jpeg';
  imageQuality: number;
  hydrationWaitMs: number;
  maxImageBytes: number;
  protectedRoutes?: string[];
}

export function generateVisualProbeScript(params: VisualProbeScriptParams): string {
  return `
const fs = require('fs');
const crypto = require('crypto');

// Apply the Lambda shim before loading Chromium on Amazon Linux 2023.
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
const FULL_PAGE = ${params.fullPage};
const IMAGE_TYPE = ${JSON.stringify(params.imageType)};
const IMAGE_QUALITY = ${params.imageQuality};
const HYDRATION_WAIT_MS = ${params.hydrationWaitMs};
const MAX_IMAGE_BYTES = ${params.maxImageBytes};
const LOCAL_ORIGIN = \`http://127.0.0.1:\${PORT}\`;
const PROTECTED_ROUTES = new Set(${JSON.stringify(
    params.protectedRoutes || [],
  )}.map((route) => normalizedPathname(route)));
const CAPTURE_DIRECTORY = '/tmp/visual-probe-captures';
const MAX_TELEMETRY_ENTRIES = 50;
const HARNESS_TRACKING_SCRIPT_URL = ${JSON.stringify(HARNESS_TRACKING_SCRIPT_URL)};

const consoleEntries = [];
const pageErrors = [];
const failedRequests = [];
const screenshots = [];
const authRedirects = [];
const telemetryDropped = { console: 0, pageErrors: 0, failedRequests: 0 };

fs.mkdirSync(CAPTURE_DIRECTORY, { recursive: true });

function routeFilename(route, viewport) {
  const safeRoute = route.replace(/^\\/+/, '').replace(/[^a-z0-9-_]/gi, '_') || 'root';
  const routeHash = crypto.createHash('sha256').update(route).digest('hex').slice(0, 10);
  const extension = IMAGE_TYPE === 'jpeg' ? 'jpg' : 'png';
  return \`\${safeRoute}__\${routeHash}__\${viewport}.\${extension}\`;
}

function pushBounded(collection, value, key) {
  if (collection.length < MAX_TELEMETRY_ENTRIES) {
    collection.push(value);
  } else {
    telemetryDropped[key]++;
  }
}

function isHarnessTrackingTelemetry(...values) {
  return values.some(value =>
    typeof value === 'string' && value.includes(HARNESS_TRACKING_SCRIPT_URL)
  );
}

function telemetryCheckpoint() {
  return {
    consoleLength: consoleEntries.length,
    pageErrorsLength: pageErrors.length,
    failedRequestsLength: failedRequests.length,
    dropped: { ...telemetryDropped },
  };
}

function restoreTelemetry(checkpoint) {
  consoleEntries.length = checkpoint.consoleLength;
  pageErrors.length = checkpoint.pageErrorsLength;
  failedRequests.length = checkpoint.failedRequestsLength;
  Object.assign(telemetryDropped, checkpoint.dropped);
}

function normalizedLocation(value) {
  try {
    const url = new URL(value, LOCAL_ORIGIN);
    const pathname = url.pathname.replace(/\\/+$/, '') || '/';
    return { origin: url.origin, pathname };
  } catch {
    return { origin: '', pathname: '/' };
  }
}

function normalizedPathname(url) {
  return normalizedLocation(url).pathname;
}

function isAuthRedirect(requestedRoute, finalUrl) {
  const requested = normalizedLocation(requestedRoute);
  const final = normalizedLocation(finalUrl);
  if (
    requested.origin !== LOCAL_ORIGIN ||
    final.origin !== LOCAL_ORIGIN ||
    requested.pathname === final.pathname ||
    !PROTECTED_ROUTES.has(requested.pathname)
  ) {
    return false;
  }
  return /^\\/(?:auth|login|log-in|signin|sign-in)(?:\\/|$)/i.test(final.pathname);
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
          if (isHarnessTrackingTelemetry(loc?.url, msg.text())) return;
          pushBounded(consoleEntries, {
            level: levelMap[type] || 'log',
            text: msg.text().slice(0, 600),
            source: loc?.url ? \`\${loc.url}:\${loc.lineNumber || 0}\` : undefined,
            route: safeRoute,
            viewport: viewport.name,
          }, 'console');
        });

        page.on('pageerror', (err) => {
          if (isHarnessTrackingTelemetry(err.message, err.stack)) return;
          pushBounded(pageErrors, {
            message: err.message.slice(0, 400),
            stack_tail: err.stack ? err.stack.split('\\n').slice(-3).join('\\n').slice(0, 400) : undefined,
            route: safeRoute,
            viewport: viewport.name,
          }, 'pageErrors');
        });

        page.on('requestfailed', (req) => {
          if (isHarnessTrackingTelemetry(req.url())) return;
          pushBounded(failedRequests, {
            url: req.url().slice(0, 300),
            failure: req.failure()?.errorText,
            resource_type: req.resourceType(),
            route: safeRoute,
            viewport: viewport.name,
          }, 'failedRequests');
        });

        page.on('response', (res) => {
          if (isHarnessTrackingTelemetry(res.url())) return;
          if (res.status() >= 400) {
            pushBounded(failedRequests, {
              url: res.url().slice(0, 300),
              status: res.status(),
              resource_type: res.request().resourceType(),
              route: safeRoute,
              viewport: viewport.name,
            }, 'failedRequests');
          }
        });

        let responseStatus = 0;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const checkpoint = telemetryCheckpoint();
          try {
            responseStatus = 0;
            const resp = await page.goto(target, { waitUntil: 'load', timeout: TIMEOUT_MS });
            responseStatus = resp?.status() || 0;
            if (responseStatus === 502 || responseStatus === 503 || responseStatus === 504) {
              if (attempt < 2) {
                restoreTelemetry(checkpoint);
                await new Promise(r => setTimeout(r, 1000));
                continue;
              }
            }
            break;
          } catch (e) {
            if (attempt < 2 && (e.message.includes('ERR_CONNECTION_REFUSED') || e.message.includes('ERR_NAME_NOT_RESOLVED') || e.message.includes('Timeout'))) {
              restoreTelemetry(checkpoint);
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }
            pushBounded(failedRequests, {
              url: target,
              failure: \`goto: \${e.message.slice(0, 200)}\`,
              resource_type: 'document',
              route: safeRoute,
              viewport: viewport.name,
            }, 'failedRequests');
            if (!e.message.toLowerCase().includes('timeout')) break;
            break;
          }
        }

        await new Promise(r => setTimeout(r, HYDRATION_WAIT_MS));
        const finalLocation = normalizedLocation(page.url());
        const finalRoute = finalLocation.pathname;
        if (isAuthRedirect(safeRoute, page.url())) {
          authRedirects.push({
            route: safeRoute,
            viewport: viewport.name,
            redirected_to: finalRoute,
          });
          continue;
        }
        if (
          finalLocation.origin !== LOCAL_ORIGIN ||
          normalizedPathname(safeRoute) !== finalRoute
        ) {
          const redirectedTo =
            finalLocation.origin === LOCAL_ORIGIN
              ? finalRoute
              : \`\${finalLocation.origin}\${finalRoute}\`;
          pushBounded(failedRequests, {
            url: target,
            failure: \`navigation unexpectedly redirected to \${redirectedTo}\`,
            resource_type: 'document',
            route: safeRoute,
            viewport: viewport.name,
          }, 'failedRequests');
        }

        try {
          const screenshotOptions = { type: IMAGE_TYPE, fullPage: FULL_PAGE };
          if (IMAGE_TYPE === 'jpeg') screenshotOptions.quality = IMAGE_QUALITY;
          let buf = await page.screenshot(screenshotOptions);
          if (buf.length > MAX_IMAGE_BYTES && IMAGE_TYPE === 'jpeg') {
            buf = await page.screenshot({
              ...screenshotOptions,
              quality: Math.max(30, Math.min(40, IMAGE_QUALITY)),
            });
          }
          if (buf.length > MAX_IMAGE_BYTES) {
            throw new Error(
              \`capture is \${buf.length} bytes; maximum is \${MAX_IMAGE_BYTES}\`,
            );
          }

          let domSnippet = '';
          try {
            domSnippet = await page.evaluate(() => {
              const body = document.body.cloneNode(true);
              const tagsToRemove = ['script', 'style', 'svg', 'iframe', 'noscript'];
              tagsToRemove.forEach(tag => {
                const elements = body.querySelectorAll(tag);
                elements.forEach(el => el.parentNode?.removeChild(el));
              });
              const allElements = body.querySelectorAll('*');
              allElements.forEach(el => {
                el.removeAttribute('class');
                el.removeAttribute('style');
                el.removeAttribute('data-reactroot');
              });

              const html = body.innerHTML.replace(/\\s+/g, ' ').trim();
              return html.length > 2500 ? html.substring(0, 2500) + '... [TRUNCATED]' : html;
            });
          } catch (e) {
            console.error(\`[VisualProbe] Failed to extract DOM for \${safeRoute}: \${e.message}\`);
          }

          if (buf && buf.length > 0) {
            const localPath = \`\${CAPTURE_DIRECTORY}/\${routeFilename(safeRoute, viewport.name)}\`;
            fs.writeFileSync(localPath, buf);
            screenshots.push({
              route: safeRoute,
              final_route: finalRoute,
              viewport: viewport.name,
              local_path: localPath,
              content_type: IMAGE_TYPE === 'jpeg' ? 'image/jpeg' : 'image/png',
              byte_size: buf.length,
              dom_snippet: domSnippet
            });
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
    console.log(JSON.stringify({
      screenshots,
      authRedirects,
      consoleEntries,
      pageErrors,
      failedRequests,
      telemetryDropped
    }));
  }
}

run();
`;
}
