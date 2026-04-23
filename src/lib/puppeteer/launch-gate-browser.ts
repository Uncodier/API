/**
 * Browser launch for cron gate probes (visual + E2E) running on the API host.
 *
 * Full `puppeteer` downloads Chrome to ~/.cache, which is empty on Vercel
 * serverless — use `puppeteer-core` + `@sparticuz/chromium` there instead.
 * Skip that path for `vercel dev` (VERCEL_ENV=development) so local macOS
 * keeps using bundled Chrome from `puppeteer`.
 */
import { existsSync, unlinkSync } from 'node:fs';
import type { Browser } from 'puppeteer-core';
import puppeteerCore from 'puppeteer-core';

/**
 * Vercel Workflow / isolated step runtimes often omit `VERCEL=1` but still run on
 * Linux with `HOME` like `/home/sbx_user…` and no puppeteer cache — we must not
 * fall through to full `puppeteer` there.
 */
function useServerlessChromium(): boolean {
  if (process.env.AWS_LAMBDA_FUNCTION_VERSION || process.env.AWS_EXECUTION_ENV) {
    return true;
  }

  // `vercel dev` — use bundled Chrome from `puppeteer` (macOS/Windows).
  if (process.env.VERCEL_ENV === 'development') {
    return false;
  }

  if (process.env.VERCEL === '1' || process.env.VERCEL === 'true') {
    return true;
  }
  if (process.env.VERCEL_URL) {
    return true;
  }
  if (process.env.VERCEL_ENV === 'production' || process.env.VERCEL_ENV === 'preview') {
    return true;
  }
  if (process.env.VERCEL_DEPLOYMENT_ID) {
    return true;
  }
  if (process.env.HOME?.includes('sbx_user')) {
    return true;
  }

  return false;
}

/**
 * Sparticuz only inflates `al2023.tar.br` (libnss3, libnspr4, …) when
 * `isRunningInAwsLambdaNode20()` is true, which reads `AWS_EXECUTION_ENV` /
 * `AWS_LAMBDA_JS_RUNTIME`. Vercel does not set those, so Chromium is extracted
 * without NSS libs → Code 127. Set Lambda-like markers before loading the
 * package so its module initializer runs `setupLambdaEnvironment` and
 * `executablePath` unpacks dependencies. Skip when already on real Lambda.
 */
function applySparticuzLambdaShimForVercel(): void {
  if (process.env.AWS_EXECUTION_ENV || process.env.AWS_LAMBDA_FUNCTION_VERSION) {
    return;
  }
  const major = parseInt(process.versions.node.split('.')[0] ?? '20', 10);
  // Package only matches 18 (al2) vs 20+/22+ (al2023). Map Node 21+ to 22.x.
  if (major >= 22 || major === 21) {
    process.env.AWS_LAMBDA_JS_RUNTIME ??= 'nodejs22.x';
    process.env.AWS_EXECUTION_ENV ??= 'AWS_Lambda_nodejs22.x';
  } else if (major >= 20) {
    process.env.AWS_LAMBDA_JS_RUNTIME ??= 'nodejs20.x';
    process.env.AWS_EXECUTION_ENV ??= 'AWS_Lambda_nodejs20.x';
  } else {
    process.env.AWS_LAMBDA_JS_RUNTIME ??= 'nodejs18.x';
    process.env.AWS_EXECUTION_ENV ??= 'AWS_Lambda_nodejs18.x';
  }
}

/** Warm invocations can reuse `/tmp/chromium` from a broken run that skipped NSS extract. */
function clearStaleSparticuzChromiumBinary(): void {
  if (!existsSync('/tmp/chromium')) return;
  if (existsSync('/tmp/al2023/lib/libnss3.so') || existsSync('/tmp/al2/lib/libnss3.so')) {
    return;
  }
  try {
    unlinkSync('/tmp/chromium');
  } catch {
    /* ignore */
  }
}

export async function launchPuppeteerForGate(): Promise<Browser> {
  if (useServerlessChromium()) {
    applySparticuzLambdaShimForVercel();
    clearStaleSparticuzChromiumBinary();
    const chromium = (await import('@sparticuz/chromium')).default;
    const executablePath = await chromium.executablePath();
    return puppeteerCore.launch({
      args: [
        ...chromium.args,
        '--disable-dev-shm-usage',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });
  }

  const puppeteer = (await import('puppeteer')).default;
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  }) as Promise<Browser>;
}
