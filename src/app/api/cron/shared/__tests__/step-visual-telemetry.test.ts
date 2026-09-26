import {
  dedupeFailedRequests,
  filterHarnessOwnedTelemetry,
  HARNESS_TRACKING_SCRIPT_URL,
  isPlatformTrackingScriptUrl,
} from '../step-visual-telemetry';
import { generateVisualProbeScript } from '../step-visual-probe-script';
import { runInNewContext } from 'node:vm';
import crypto from 'node:crypto';

describe('visual telemetry filtering', () => {
  it('identifies known platform script origins and paths, including versioned URLs', () => {
    expect(isPlatformTrackingScriptUrl(HARNESS_TRACKING_SCRIPT_URL)).toBe(true);
    expect(isPlatformTrackingScriptUrl('https://files.uncodie.com/tracking.min.js')).toBe(true);
    expect(isPlatformTrackingScriptUrl('https://backend.makinari.com/tracking.min.js')).toBe(true);
    expect(isPlatformTrackingScriptUrl('https://backend.makinari.com/tracking.min.js?v=2')).toBe(true);
    expect(isPlatformTrackingScriptUrl(`${HARNESS_TRACKING_SCRIPT_URL}&cache=2`)).toBe(true);
    expect(isPlatformTrackingScriptUrl('https://files.uncodie.com/tracking.min.js.attacker.invalid?v=1.959')).toBe(false);
    expect(isPlatformTrackingScriptUrl('https://backend.makinari.com/other.js')).toBe(false);
    expect(isPlatformTrackingScriptUrl('https://images.unsplash.com/photo.jpg')).toBe(false);
  });

  it('prevents known platform scripts from loading without aborting other requests', () => {
    const script = generateVisualProbeScript({
      port: 3000,
      pageRoutes: ['/'],
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      pageTimeoutMs: 10_000,
      fullPage: false,
      imageType: 'jpeg',
      imageQuality: 60,
      hydrationWaitMs: 500,
      maxImageBytes: 900_000,
    });
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('await page.setRequestInterception(true)');
    expect(script).toContain('https://backend.makinari.com/tracking.min.js');
    expect(script).toContain("request.respond({ status: 200, contentType: 'application/javascript', body: '' })");
    expect(script).toContain('request.continue()');
  });

  it('runs the generated browser script: suppresses tracking before the telemetry cap and continues application requests', async () => {
    const script = generateVisualProbeScript({
      port: 3000, pageRoutes: ['/'],
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      pageTimeoutMs: 1_000, fullPage: false, imageType: 'jpeg',
      imageQuality: 60, hydrationWaitMs: 0, maxImageBytes: 900_000,
    });
    const listeners = new Map<string, Function>();
    const actions: string[] = [];
    const page = {
      setDefaultNavigationTimeout: () => {}, setDefaultTimeout: () => {},
      setRequestInterception: async () => {},
      on: (event: string, handler: Function) => { listeners.set(event, handler); },
      removeAllListeners: (event: string) => { listeners.delete(event); },
      setViewport: async () => {},
      goto: async () => {
        const requestHandler = listeners.get('request')!;
        const emit = (url: string, resourceType: string) => {
          let handled = false;
          return requestHandler({
            url: () => url, resourceType: () => resourceType,
            isInterceptResolutionHandled: () => handled,
            respond: async () => { handled = true; actions.push(`respond:${url}`); },
            continue: async () => { handled = true; actions.push(`continue:${url}`); },
          });
        };
        await emit('http://127.0.0.1:3000/', 'document');
        await emit('https://backend.makinari.com/tracking.min.js?v=2', 'script');
        await emit('https://example.com/app.js', 'script');
        for (let i = 0; i < 55; i++) {
          listeners.get('console')!({
            type: () => 'error', text: () => 'tracking failure',
            location: () => ({ url: 'https://backend.makinari.com/tracking.min.js?v=2', lineNumber: i }),
          });
          listeners.get('requestfailed')!({
            url: () => 'https://backend.makinari.com/tracking.min.js?v=2',
            failure: () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }),
            resourceType: () => 'script',
          });
        }
        listeners.get('console')!({
          type: () => 'error', text: () => 'application failure',
          location: () => ({ url: 'https://example.com/app.js', lineNumber: 1 }),
        });
        return { status: () => 200 };
      },
      evaluate: async (fn: Function) => fn.length ? false : '<main>App</main>',
      url: () => 'http://127.0.0.1:3000/',
      screenshot: async () => Buffer.from('image'),
    };
    const output = new Promise<any>((resolve, reject) => {
      runInNewContext(script, {
        require: (name: string) => {
          if (name === 'crypto') return crypto;
          if (name === 'fs') return { existsSync: () => true, mkdirSync: () => {}, writeFileSync: () => {} };
          if (name === 'puppeteer-core') return { launch: async () => ({ newPage: async () => page, close: async () => {} }) };
          if (name === '@sparticuz/chromium') return { executablePath: async () => '/tmp/chrome', args: [], headless: true };
          throw new Error(`Unexpected module: ${name}`);
        },
        process: { versions: { node: '20.0.0' }, env: {} },
        Buffer, URL,
        setTimeout: (fn: Function) => { fn(); return 0; },
        console: { log: (value: string) => { try { resolve(JSON.parse(value)); } catch (error) { reject(error); } }, error: (value: string) => reject(new Error(value)) },
      });
    });
    const parsed = await output;
    expect(actions).toEqual([
      'continue:http://127.0.0.1:3000/',
      'respond:https://backend.makinari.com/tracking.min.js?v=2',
      'continue:https://example.com/app.js',
    ]);
    expect(parsed.telemetryDropped).toEqual({ console: 0, pageErrors: 0, failedRequests: 0 });
    expect(parsed.consoleEntries).toEqual([expect.objectContaining({ text: 'application failure' })]);
    expect(parsed.failedRequests).toEqual([]);
    expect(parsed.screenshots).toHaveLength(1);
  });

  it('surfaces failed request continuation instead of silently timing out', async () => {
    const script = generateVisualProbeScript({
      port: 3000, pageRoutes: ['/'],
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      pageTimeoutMs: 1_000, fullPage: false, imageType: 'jpeg',
      imageQuality: 60, hydrationWaitMs: 0, maxImageBytes: 900_000,
    });
    const listeners = new Map<string, Function>();
    let aborted = false;
    const page = {
      setDefaultNavigationTimeout: () => {}, setDefaultTimeout: () => {},
      setRequestInterception: async () => {},
      on: (event: string, handler: Function) => { listeners.set(event, handler); },
      removeAllListeners: (event: string) => { listeners.delete(event); },
      setViewport: async () => {},
      goto: async () => {
        await listeners.get('request')!({
          url: () => 'http://127.0.0.1:3000/', resourceType: () => 'document',
          isInterceptResolutionHandled: () => false,
          continue: async () => { throw new Error('continue failed'); },
          abort: async () => { aborted = true; },
        });
        return { status: () => 200 };
      },
      evaluate: async (fn: Function) => fn.length ? false : '<main>App</main>',
      url: () => 'http://127.0.0.1:3000/',
      screenshot: async () => Buffer.from('image'),
    };
    const output = new Promise<any>((resolve, reject) => {
      runInNewContext(script, {
        require: (name: string) => {
          if (name === 'crypto') return crypto;
          if (name === 'fs') return { existsSync: () => true, mkdirSync: () => {}, writeFileSync: () => {} };
          if (name === 'puppeteer-core') return { launch: async () => ({ newPage: async () => page, close: async () => {} }) };
          if (name === '@sparticuz/chromium') return { executablePath: async () => '/tmp/chrome', args: [], headless: true };
          throw new Error(`Unexpected module: ${name}`);
        },
        process: { versions: { node: '20.0.0' }, env: {} },
        Buffer, URL,
        setTimeout: (fn: Function) => { fn(); return 0; },
        console: { log: (value: string) => { try { resolve(JSON.parse(value)); } catch (error) { reject(error); } }, error: () => {} },
      });
    });
    const parsed = await output;
    expect(parsed.failedRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ failure: 'probe interception: continue failed', resource_type: 'document' }),
    ]));
    expect(aborted).toBe(true);
  });

  it.each([
    ['another handler already resolved the request', 'Request is already handled!', false],
    ['the continuation failed after marking the request handled', 'Fetch.continueRequest failed', true],
  ])('%s', async (_case, failure, shouldReport) => {
    const script = generateVisualProbeScript({
      port: 3000, pageRoutes: ['/'],
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      pageTimeoutMs: 1_000, fullPage: false, imageType: 'jpeg',
      imageQuality: 60, hydrationWaitMs: 0, maxImageBytes: 900_000,
    });
    const listeners = new Map<string, Function>();
    const page = {
      setDefaultNavigationTimeout: () => {}, setDefaultTimeout: () => {},
      setRequestInterception: async () => {},
      on: (event: string, handler: Function) => { listeners.set(event, handler); },
      removeAllListeners: (event: string) => { listeners.delete(event); },
      setViewport: async () => {},
      goto: async () => {
        let handled = false;
        await listeners.get('request')!({
          url: () => 'http://127.0.0.1:3000/', resourceType: () => 'document',
          isInterceptResolutionHandled: () => handled,
          continue: async () => { handled = true; throw new Error(failure); },
        });
        return { status: () => 200 };
      },
      evaluate: async (fn: Function) => fn.length ? false : '<main>App</main>',
      url: () => 'http://127.0.0.1:3000/',
      screenshot: async () => Buffer.from('image'),
    };
    const output = new Promise<any>((resolve, reject) => {
      runInNewContext(script, {
        require: (name: string) => {
          if (name === 'crypto') return crypto;
          if (name === 'fs') return { existsSync: () => true, mkdirSync: () => {}, writeFileSync: () => {} };
          if (name === 'puppeteer-core') return { launch: async () => ({ newPage: async () => page, close: async () => {} }) };
          if (name === '@sparticuz/chromium') return { executablePath: async () => '/tmp/chrome', args: [], headless: true };
          throw new Error(`Unexpected module: ${name}`);
        },
        process: { versions: { node: '20.0.0' }, env: {} },
        Buffer, URL,
        setTimeout: (fn: Function) => { fn(); return 0; },
        console: { log: (value: string) => { try { resolve(JSON.parse(value)); } catch (error) { reject(error); } }, error: () => {} },
      });
    });
    const parsed = await output;
    if (shouldReport) {
      expect(parsed.failedRequests).toEqual(expect.arrayContaining([
        expect.objectContaining({ failure: `probe interception: ${failure}`, resource_type: 'document' }),
      ]));
    } else {
      expect(parsed.failedRequests).toEqual([]);
    }
  });

  it('excludes legacy platform tracking failures but preserves application failures', () => {
    const result = filterHarnessOwnedTelemetry({
      entries: [
        { level: 'error', text: 'Failed to load resource', source: 'https://backend.makinari.com/tracking.min.js:0' },
        { level: 'error', text: 'Broken image', source: 'https://images.unsplash.com/photo.jpg:0' },
      ],
      pageErrors: [],
      failedRequests: [
        { url: 'https://backend.makinari.com/tracking.min.js', failure: 'net::ERR_NAME_NOT_RESOLVED', resource_type: 'script' },
        { url: 'https://images.unsplash.com/photo.jpg', failure: 'net::ERR_NAME_NOT_RESOLVED', resource_type: 'image' },
      ],
    });
    expect(result.entries).toEqual([expect.objectContaining({ text: 'Broken image' })]);
    expect(result.failedRequests).toEqual([expect.objectContaining({ url: 'https://images.unsplash.com/photo.jpg' })]);
  });

  it('drops only failures caused by the harness-injected tracking script', () => {
    const result = filterHarnessOwnedTelemetry({
      entries: [
        {
          level: 'error',
          text: 'Failed to load resource',
          source: `${HARNESS_TRACKING_SCRIPT_URL}:0`,
          route: '/dashboard',
          viewport: 'desktop',
        },
        {
          level: 'error',
          text: 'Product crashed',
          source: 'http://localhost/app.js:10',
          route: '/dashboard',
          viewport: 'desktop',
        },
      ],
      pageErrors: [],
      failedRequests: [
        {
          url: HARNESS_TRACKING_SCRIPT_URL,
          failure: 'net::ERR_NAME_NOT_RESOLVED',
          resource_type: 'script',
          route: '/dashboard',
          viewport: 'desktop',
        },
        {
          url: 'https://api.example.invalid/data',
          failure: 'net::ERR_FAILED',
          resource_type: 'fetch',
          route: '/dashboard',
          viewport: 'desktop',
        },
      ],
      ownedScopes: [{ route: '/dashboard', viewport: 'desktop' }],
    });

    expect(result.entries).toEqual([
      expect.objectContaining({ text: 'Product crashed' }),
    ]);
    expect(result.failedRequests).toEqual([
      expect.objectContaining({ url: 'https://api.example.invalid/data' }),
    ]);
  });

  it('drops canonical tracking failures after the ownership marker is removed', () => {
    const result = filterHarnessOwnedTelemetry({
      entries: [{
        level: 'error',
        text: 'Failed to load resource: net::ERR_NAME_NOT_RESOLVED',
        source: `${HARNESS_TRACKING_SCRIPT_URL}:0`,
        route: '/pricing',
        viewport: 'desktop',
      }],
      pageErrors: [],
      failedRequests: [{
        url: HARNESS_TRACKING_SCRIPT_URL,
        failure: 'net::ERR_NAME_NOT_RESOLVED',
        resource_type: 'script',
        route: '/pricing',
        viewport: 'desktop',
      }],
      ownedScopes: [],
    });

    expect(result.entries).toEqual([]);
    expect(result.failedRequests).toEqual([]);
  });

  it('preserves failures from lookalike tracking URLs', () => {
    const lookalikeUrl = 'https://files.uncodie.com/tracking.min.js.attacker.invalid?v=1.959';
    const result = filterHarnessOwnedTelemetry({
      entries: [{
        level: 'error',
        text: 'Failed to load resource',
        source: `${lookalikeUrl}:0`,
      }],
      pageErrors: [],
      failedRequests: [{
        url: lookalikeUrl,
        failure: 'net::ERR_NAME_NOT_RESOLVED',
        resource_type: 'script',
      }],
    });

    expect(result.entries).toHaveLength(1);
    expect(result.failedRequests).toHaveLength(1);
  });

  it('merges Next.js prefetch response and abort events for one request', () => {
    const requests = [
      {
        url: 'http://127.0.0.1:3000/privacy?_rsc=first',
        status: 404,
        resource_type: 'fetch',
        route: '/contact',
        viewport: 'desktop',
      },
      {
        url: 'http://127.0.0.1:3000/privacy?_rsc=second',
        failure: 'net::ERR_ABORTED',
        resource_type: 'fetch',
        route: '/contact',
        viewport: 'desktop',
      },
    ];
    const result = dedupeFailedRequests(requests);

    expect(result).toEqual([
      expect.objectContaining({
        status: 404,
        failure: 'net::ERR_ABORTED',
      }),
    ]);
    expect(dedupeFailedRequests([...requests].reverse())).toEqual(result);
  });

  it.each([
    ['404 then 503', [404, 503]],
    ['503 then 404', [503, 404]],
  ])('keeps the most severe status for %s', (_label, statuses) => {
    const result = dedupeFailedRequests(statuses.map((status, index) => ({
      url: `http://127.0.0.1:3000/privacy?_rsc=${index}`,
      status,
      resource_type: 'fetch',
      route: '/contact',
      viewport: 'desktop',
    })));

    expect(result).toEqual([
      expect.objectContaining({
        url: 'http://127.0.0.1:3000/privacy',
        status: 503,
      }),
    ]);
  });
});
