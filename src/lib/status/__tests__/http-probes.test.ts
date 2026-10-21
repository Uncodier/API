import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { probeHttpRoute } from '@/lib/status/probe-base-url';
import { agentsHandler } from '@/lib/status/handlers/agents';
import { finderHandler } from '@/lib/status/handlers/finder';
import { robotsHandler } from '@/lib/status/handlers/robots';
import { siteHandler } from '@/lib/status/handlers/site';
import { visitorsHandler } from '@/lib/status/handlers/visitors';
import { workflowHandler } from '@/lib/status/handlers/workflow';
import { publicApiHandler } from '@/lib/status/handlers/public-api';
import type { SystemHealthHandler } from '@/lib/status/types';

const originalEnv = process.env;
const originalFetch = globalThis.fetch;
const fetchMock = jest.fn<typeof fetch>();
let siteId: string;

const rss = '<?xml version="1.0"?><rss version="2.0"><channel>' +
  '<title>Probe feed</title><link>https://example.test/blog</link>' +
  '<description>Published posts</description></channel></rss>';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function publicResponse(path: string): Response {
  return path === '/api/public/rss'
    ? new Response(rss, { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } })
    : json({ success: true, data: [], site: { id: siteId } });
}

function contractResponse(path: string, method = 'GET'): Response {
  switch (path) {
    case '/api/agents/apps/list': return json({ success: false, error: 'site_id is required' }, 400);
    case '/api/site/requirements': return json({
      error: 'Parámetros inválidos', details: [{ path: ['url'] }, { path: ['segment_id'] }],
    }, 400);
    case '/api/visitors/identify': return method === 'OPTIONS'
      ? new Response(null, { status: 204, headers: { 'access-control-allow-methods': 'GET, POST, OPTIONS' } })
      : new Response(null, { status: 405 });
    case '/api/instances': return json({ instances: [], limit: 50, offset: 0 });
    default: return new Response(null, { status: 405 });
  }
}

beforeEach(() => {
  process.env = { ...originalEnv, NODE_ENV: 'test', STATUS_PROBE_BASE_URL: 'https://example.test' };
  for (const key of ['STATUS_PROBE_SITE_ID', 'VERCEL_AUTOMATION_BYPASS_SECRET', 'VERCEL_URL',
    'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_ENV', 'SCRAPYBARA_API_KEY', 'SCRAPYBARA_API_KEY_ID']) {
    delete process.env[key];
  }
  process.env.SERVICE_API_KEY = randomBytes(32).toString('hex');
  siteId = randomUUID();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
});

describe('HTTP probe transport and exact statuses (offline)', () => {
  it('defaults to only 200 and forces fresh, non-redirecting requests', async () => {
    fetchMock.mockResolvedValue(new Response('OK'));
    await expect(probeHttpRoute('/api/test', { cache: 'force-cache', redirect: 'follow' }))
      .resolves.toMatchObject({ ok: true, status: 200 });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.test/api/test');
    expect(options).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.headers).toBeInstanceOf(Headers);
    expect(new Headers(options?.headers).get('x-api-key')).toBe(process.env.SERVICE_API_KEY);
    expect(options).not.toHaveProperty('expectedStatuses');
    expect(options).not.toHaveProperty('validateResponse');
  });

  it.each([0, 201, 204, 301, 302, 303, 307, 308, 400, 401, 403, 404, 405, 429, 500, 503])(
    'rejects status %i with the default contract', async (status) => {
      fetchMock.mockResolvedValue(status === 0 ? Response.error() : new Response(null, { status }));
      await expect(probeHttpRoute('/api/test')).resolves.toMatchObject({ ok: false, status });
    },
  );

  it.each([0, 301, 302, 307, 308, 401, 403, 404, 429, 500])(
    'cannot allow forbidden status %i even with an explicit expected status', async (status) => {
      fetchMock.mockResolvedValue(status === 0 ? Response.error() : new Response(null, { status }));
      await expect(probeHttpRoute('/api/test', { expectedStatuses: [status] }))
        .resolves.toMatchObject({ ok: false, status });
    },
  );

  it.each([400, 405, 204])('accepts an explicit negative/method contract status %i', async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    await expect(probeHttpRoute('/api/test', { expectedStatuses: [status] }))
      .resolves.toMatchObject({ ok: true, status });
  });

  it('rejects an already-followed redirect even if its final status is 200', async () => {
    const response = new Response('login page');
    Object.defineProperty(response, 'redirected', { value: true });
    fetchMock.mockResolvedValue(response);
    await expect(probeHttpRoute('/api/test')).resolves.toMatchObject({ ok: false, status: 200 });
  });

  it('fails closed when there is no production base URL', async () => {
    process.env = { ...process.env, NODE_ENV: 'production' };
    delete process.env.STATUS_PROBE_BASE_URL;
    await expect(probeHttpRoute('/api/test')).resolves.toMatchObject({ ok: false, status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not expose transport errors, authenticated URLs, or thrown strings', async () => {
    const username = randomBytes(16).toString('hex');
    const password = randomBytes(16).toString('hex');
    const token = randomBytes(24).toString('hex');
    const url = new URL('https://example.invalid/probe');
    url.username = username;
    url.password = password;
    url.searchParams.set('token', token);
    const detail = `${url} Authorization: Bearer ${process.env.SERVICE_API_KEY}`;
    for (const error of [new TypeError(detail), detail]) {
      fetchMock.mockRejectedValueOnce(error);
      const result = await probeHttpRoute('/api/test');
      expect(result).toMatchObject({ ok: false, status: 0, error: 'HTTP probe request failed' });
      for (const value of [username, password, token, process.env.SERVICE_API_KEY!]) {
        expect(JSON.stringify(result)).not.toContain(value);
      }
    }
  });

  it.each(['headers', 'tuples', 'record'])('preserves caller authentication using %s', async (format) => {
    const authorization = `Bearer ${randomBytes(24).toString('hex')}`;
    const entries: [string, string][] = [['aUtHoRiZaTiOn', authorization], ['X-Custom', 'probe']];
    const headers = format === 'headers' ? new Headers(entries) : format === 'tuples' ? entries : Object.fromEntries(entries);
    fetchMock.mockResolvedValue(new Response('OK'));
    await probeHttpRoute('/api/test', { headers });
    const sent = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(sent.get('authorization')).toBe(authorization);
    expect(sent.get('x-custom')).toBe('probe');
    expect(sent.has('x-api-key')).toBe(false);
  });

  it('preserves mixed-case API keys, and uses a Headers copy', async () => {
    const key = randomBytes(24).toString('hex');
    const bypass = randomBytes(24).toString('hex');
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = bypass;
    const headers = new Headers({ 'X-API-KEY': key });
    fetchMock.mockResolvedValue(new Response('OK'));
    await probeHttpRoute('/api/test', { headers });
    const sent = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(sent.get('x-api-key')).toBe(key);
    expect(sent.get('x-vercel-protection-bypass')).toBe(bypass);
    expect(headers.has('x-vercel-protection-bypass')).toBe(false);
  });

  it('can opt out of service authentication', async () => {
    fetchMock.mockResolvedValue(new Response('OK'));
    await probeHttpRoute('/api/test', { useServiceKey: false });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('x-api-key')).toBe(false);
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('useServiceKey');
  });
});

describe('bounded response validators', () => {
  it('passes a bounded body and Headers, not a raw Response', async () => {
    fetchMock.mockResolvedValue(json({ success: true }));
    const validator = jest.fn((body: string, headers: Headers) =>
      JSON.parse(body).success === true && headers.get('content-type') === 'application/json');
    await expect(probeHttpRoute('/api/test', { validateResponse: validator }))
      .resolves.toMatchObject({ ok: true, status: 200 });
    expect(validator).toHaveBeenCalledWith('{"success":true}', expect.any(Headers));
  });

  it('sanitizes false, parse failures and validator exceptions without exposing upstream bodies', async () => {
    const marker = randomBytes(32).toString('hex');
    for (const validator of [() => false, (body: string) => JSON.parse(body), () => { throw new Error(marker); }]) {
      fetchMock.mockResolvedValueOnce(new Response(marker));
      const result = await probeHttpRoute('/api/test', { validateResponse: validator });
      expect(result).toMatchObject({ ok: false, status: 200, error: 'HTTP response validation failed' });
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });

  it('never validates or returns unexpected upstream error bodies', async () => {
    const marker = randomBytes(32).toString('hex');
    const validator = jest.fn(() => true);
    fetchMock.mockResolvedValue(json({ error: marker }, 429));
    const result = await probeHttpRoute('/api/test', { validateResponse: validator });
    expect(validator).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(result).toMatchObject({ ok: false, status: 429, error: 'Unexpected HTTP status' });
  });

  it.each(['declared', 'streamed', 'multibyte', 'default', 'hard-cap'])(
    'enforces the byte limit for %s bodies before validation', async (mode) => {
      const validator = jest.fn(() => true);
      const cancel = jest.fn<() => void>();
      const bytes = new TextEncoder().encode(mode === 'multibyte' ? 'ééé' : 'x'.repeat(
        mode === 'default' ? 64 * 1024 + 1 : mode === 'hard-cap' ? 256 * 1024 + 1 : 6,
      ));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); },
        cancel,
      });
      fetchMock.mockResolvedValue(new Response(stream, {
        headers: mode === 'declared' ? { 'content-length': '6' } : {},
      }));
      const result = await probeHttpRoute('/api/test', {
        validateResponse: validator,
        ...(mode !== 'default' ? { maxResponseBytes: mode === 'hard-cap' ? 1024 * 1024 : 5 } : {}),
      });
      expect(result).toMatchObject({ ok: false, status: 200, error: 'HTTP response validation failed' });
      expect(validator).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalled();
    },
  );

  it('accepts a body exactly at its byte limit', async () => {
    fetchMock.mockResolvedValue(new Response('éé'));
    await expect(probeHttpRoute('/api/test', { maxResponseBytes: 4, validateResponse: (body) => body === 'éé' }))
      .resolves.toMatchObject({ ok: true });
  });

  it('combines caller cancellation with the probe deadline and bounds hanging validators', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    fetchMock.mockResolvedValue(new Response('OK'));
    const pending = probeHttpRoute('/api/test', {
      signal: controller.signal,
      validateResponse: () => { entered(); return new Promise<boolean>(() => {}); },
    });
    await ready;
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal).not.toBe(controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, status: 200, error: 'HTTP response validation failed' });
    expect(signal?.aborted).toBe(true);
  });

  it('does not fetch with an already-aborted caller signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(probeHttpRoute('/api/test', { signal: controller.signal }))
      .resolves.toMatchObject({ ok: false, status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['transport', 'body', 'validator'])('bounds a hanging %s with the 12-second probe deadline', async (phase) => {
    const controller = new AbortController();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    if (phase === 'transport') {
      fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    } else if (phase === 'body') {
      fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>()));
    } else {
      fetchMock.mockResolvedValue(new Response('OK'));
    }
    const pending = probeHttpRoute('/api/test', {
      validateResponse: () => phase === 'validator' ? new Promise<boolean>(() => {}) : true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, status: phase === 'transport' ? 0 : 200 });
    expect(timeout).toHaveBeenCalledWith(12_000);
  });
});

const contractHandlers = [agentsHandler, finderHandler, siteHandler, visitorsHandler, workflowHandler];
const allHandlers = [...contractHandlers, robotsHandler, publicApiHandler];

describe('handler contracts and failure propagation', () => {
  it.each(contractHandlers.map((handler) => [handler.systemKey, handler] as const))(
    '%s verifies only its safe route contract, without claiming functional/DB evidence', async (_, handler) => {
      fetchMock.mockImplementation(async (url, options) => contractResponse(new URL(String(url)).pathname, options?.method));
      const result = await handler.runCheck();
      expect(result.status).toBe('up');
      expect(result.summary).toMatch(/contract verified|contracts verified/);
      expect(result.summary).toContain('unverified');
      expect(result.checks).toMatchObject({ verification: 'contract', functionalVerified: false });
      expect(result.checks).not.toHaveProperty('supabaseRead');
      for (const [url, options] of fetchMock.mock.calls) {
        expect(['GET', 'OPTIONS']).toContain(options?.method);
        expect(new URL(String(url)).search).toBe('');
        expect(options?.body).toBeUndefined();
      }
    },
  );

  it.each(allHandlers.map((handler) => [handler.systemKey, handler] as const))(
    '%s reports down for status zero, transport, auth, missing, rate limit and redirects', async (_, handler) => {
      process.env.STATUS_PROBE_SITE_ID = siteId;
      for (const status of [0, 401, 403, 404, 429, 302, 500]) {
        fetchMock.mockImplementation(async () => status === 0 ? Response.error() : new Response(null, { status }));
        const result = await handler.runCheck();
        expect(result.status).toBe('down');
      }
      fetchMock.mockRejectedValue(new TypeError(randomBytes(24).toString('hex')));
      expect((await handler.runCheck()).status).toBe('down');
    },
  );

  it.each(contractHandlers.map((handler) => [handler.systemKey, handler] as const))(
    '%s does not accept an unrelated 200 as its negative contract', async (_, handler) => {
      fetchMock.mockImplementation(async () => json({ success: true }));
      expect((await handler.runCheck()).status).toBe('down');
    },
  );

  it.each([
    ['agents', agentsHandler, json({ success: false, error: 'wrong contract' }, 400)],
    ['site', siteHandler, json({ error: 'Parámetros inválidos', details: [] }, 400)],
    ['visitors', visitorsHandler, new Response(null, { status: 204 })],
  ] as [string, SystemHealthHandler, Response][])('%s rejects malformed validation/method contracts', async (_, handler, response) => {
    fetchMock.mockImplementation(async (url) => new URL(String(url)).pathname === '/api/agents/supervisor'
      ? new Response(null, { status: 405 }) : response.clone());
    expect((await handler.runCheck()).status).toBe('down');
  });

  it('verifies instances JSON without claiming actual robot execution', async () => {
    fetchMock.mockImplementation(async () => contractResponse('/api/instances'));
    const result = await robotsHandler.runCheck();
    expect(result.status).toBe('up');
    expect(result.checks).toMatchObject({ instanceListResponseVerified: true, robotExecutionVerified: false });
  });

  it('does not infer a registered visitor route from generic middleware preflight alone', async () => {
    fetchMock.mockImplementation(async (_url, options) => options?.method === 'OPTIONS'
      ? new Response(null, { status: 204, headers: { 'access-control-allow-methods': 'GET,POST,OPTIONS' } })
      : new Response(null, { status: 404 }));
    expect((await visitorsHandler.runCheck()).status).toBe('down');
  });

  it.each(['html', 'missing-array', 'invalid-json'])('rejects invalid instances response: %s', async (mode) => {
    fetchMock.mockResolvedValue(mode === 'missing-array' ? json({ instances: null }) :
      new Response(mode === 'html' ? '<html>Login</html>' : '{', { headers: { 'content-type': 'application/json' } }));
    expect((await robotsHandler.runCheck()).status).toBe('down');
  });
});

describe('public site response evidence', () => {
  it.each([undefined, '', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', '?site_id=other'])(
    'skips without a valid explicit site context (%s), and performs no discovery/fetch', async (value) => {
      if (value !== undefined) process.env.STATUS_PROBE_SITE_ID = value;
      const result = await publicApiHandler.runCheck();
      expect(result).toMatchObject({ status: 'skipped', checks: { verification: 'unverified', siteContextConfigured: false, routes: [] } });
      expect(result.summary).toContain('unverified');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('requires matching site JSON and minimal RSS, sending explicit context but no service key', async () => {
    process.env.STATUS_PROBE_SITE_ID = ` ${siteId.toUpperCase()} `;
    fetchMock.mockImplementation(async (url) => publicResponse(new URL(String(url)).pathname));
    const result = await publicApiHandler.runCheck();
    expect(result.status).toBe('up');
    expect(result.checks).toMatchObject({ verification: 'response', siteContextConfigured: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [raw, options] of fetchMock.mock.calls) {
      const url = new URL(String(raw));
      expect(url.searchParams.get('site_id')).toBe(siteId.toUpperCase());
      expect(options).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
      const headers = new Headers(options?.headers);
      expect(headers.has('x-api-key')).toBe(false);
      expect(headers.has('authorization')).toBe(false);
    }
  });

  it.each(['/api/public/content', '/api/public/posts'])(
    '%s requires success:true, a data array and the selected site, not just 200', async (target) => {
      process.env.STATUS_PROBE_SITE_ID = siteId;
      for (const response of [
        json({ success: false, data: [], site: { id: siteId } }),
        json({ success: true, data: {}, site: { id: siteId } }),
        json({ success: true, data: [] }),
        json({ success: true, data: [], site: { id: randomUUID() } }),
        new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }),
        new Response('{', { headers: { 'content-type': 'application/json' } }),
      ]) {
        fetchMock.mockImplementation(async (url) => new URL(String(url)).pathname === target
          ? response.clone() : publicResponse(new URL(String(url)).pathname));
        const result = await publicApiHandler.runCheck();
        expect(result.status).toBe('degraded');
        expect(result.checks.routes).toEqual(expect.arrayContaining([{ path: target, status: 200, ok: false }]));
      }
    },
  );

  it.each([
    ['HTML', '<html><body>Login</body></html>', 'text/html'],
    ['HTML mislabeled as RSS', '<html><body>Login</body></html>', 'application/rss+xml'],
    ['RSS mislabeled as HTML', rss, 'text/html'],
    ['empty RSS', '<rss version="2.0"/>', 'application/rss+xml'],
    ['incomplete channel', '<rss version="2.0"><channel><title>Feed</title></channel></rss>', 'application/rss+xml'],
    ['malformed XML', rss.replace('</channel>', ''), 'application/rss+xml'],
    ['multiple roots', `${rss}<html/>`, 'application/rss+xml'],
    ['wrong version', rss.replace('version="2.0"', 'version="1.0"'), 'application/rss+xml'],
    ['doctype', '<!DOCTYPE rss [<!ENTITY item "content">]>' + rss, 'application/rss+xml'],
    ['oversized', rss.replace('Probe feed', 'x'.repeat(64 * 1024)), 'application/rss+xml'],
  ])('rejects invalid RSS: %s', async (_, body, contentType) => {
    process.env.STATUS_PROBE_SITE_ID = siteId;
    fetchMock.mockImplementation(async (url) => new URL(String(url)).pathname === '/api/public/rss'
      ? new Response(body, { headers: { 'content-type': contentType } }) : publicResponse(new URL(String(url)).pathname));
    const result = await publicApiHandler.runCheck();
    expect(result.status).toBe('degraded');
    expect(result.checks.routes).toEqual(expect.arrayContaining([{ path: '/api/public/rss', status: 200, ok: false }]));
  });

  it('accepts a valid feed with numeric text fields', async () => {
    process.env.STATUS_PROBE_SITE_ID = siteId;
    fetchMock.mockImplementation(async (url) => new URL(String(url)).pathname === '/api/public/rss'
      ? new Response(rss.replace('Probe feed', '2026'), { headers: { 'content-type': 'application/rss+xml' } })
      : publicResponse(new URL(String(url)).pathname));
    expect((await publicApiHandler.runCheck()).status).toBe('up');
  });

  it('reports down when every public response is invalid and never includes raw bodies', async () => {
    process.env.STATUS_PROBE_SITE_ID = siteId;
    const marker = randomBytes(32).toString('hex');
    fetchMock.mockImplementation(async () => json({ success: false, error: marker }));
    const result = await publicApiHandler.runCheck();
    expect(result.status).toBe('down');
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});