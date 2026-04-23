/**
 * Browser launch for cron gate probes (visual + E2E) running on the API host.
 *
 * Full `puppeteer` downloads Chrome to ~/.cache, which is empty on Vercel
 * serverless — use `puppeteer-core` + `@sparticuz/chromium` there instead.
 * Skip that path for `vercel dev` (VERCEL_ENV=development) so local macOS
 * keeps using bundled Chrome from `puppeteer`.
 */
import type { Browser } from 'puppeteer-core';
import puppeteerCore from 'puppeteer-core';

function useServerlessChromium(): boolean {
  if (process.env.AWS_LAMBDA_FUNCTION_VERSION) return true;
  if (process.env.VERCEL !== '1') return false;
  return process.env.VERCEL_ENV !== 'development';
}

export async function launchPuppeteerForGate(): Promise<Browser> {
  if (useServerlessChromium()) {
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
