import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dispatchMarketFitWorker } from '../market-fit-dispatch';
import { GET as marketplaceCron } from '@/app/api/cron/marketplace/route';
import { GET as topUpCron } from '@/app/api/cron/credit-auto-top-up/route';

const originalEnvironment = { ...process.env };
const originalFetch = global.fetch;
let cronSecret: string;
let dispatchSecret: string;
const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const request = (token = cronSecret) => new Request('https://api.example.test/api/cron/marketplace?url=https://other.example.test', {
  headers: { authorization: `Bearer ${token}` },
});
const result = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
  jest.resetAllMocks();
  cronSecret = randomBytes(32).toString('hex');
  dispatchSecret = randomBytes(32).toString('hex');
  process.env.CRON_SECRET = cronSecret;
  process.env.SERVICE_API_KEY = dispatchSecret;
  process.env.NEXT_PUBLIC_APP_URL = 'https://commerce.example.test';
  global.fetch = fetchMock;
});
afterEach(() => { jest.useRealTimers(); process.env = { ...originalEnvironment }; global.fetch = originalFetch; });

describe('single-owner commerce cron dispatch', () => {
  it('fails closed before any outbound request for absent or invalid cron credentials', async () => {
    expect((await marketplaceCron(request(randomBytes(32).toString('hex')))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await marketplaceCron(request())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fails closed when the existing service credential is absent', async () => {
    delete process.env.SERVICE_API_KEY;
    expect((await marketplaceCron(request())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requires the existing application URL rather than guessing a production destination', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect((await marketplaceCron(request())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses the existing app URL and x-api-key contract without forwarding cron credentials', async () => {
    fetchMock.mockResolvedValue(result({ refreshed: 4, unavailable: 0 }));
    const response = await marketplaceCron(request());
    expect(response.status).toBe(200);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://commerce.example.test/api/marketplace/worker');
    expect(options).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error',
      headers: { 'x-api-key': dispatchSecret } });
    expect(new Headers(options?.headers).has('authorization')).toBe(false);
    expect(JSON.stringify(options)).not.toContain(cronSecret);
    const body = await response.text();
    expect(body).not.toContain(dispatchSecret);
    expect(body).not.toContain(cronSecret);
  });
  it('preserves actual Stripe outcomes without requesting another charge', async () => {
    fetchMock.mockResolvedValue(result({ results: [{ siteId: randomUUID(), outcome: 'canceled' }], deferred: 0 }));
    const response = await topUpCron(request());
    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://commerce.example.test/api/stripe/auto-top-up/worker');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(['http://app.makinari.com', 'https://evil.invalid', 'https://169.254.169.254',
    'https://app.makinari.com/override', 'https://app.makinari.com?target=other',
    'https://app.makinari.com:444'])('rejects unsafe configured worker origin %s', async origin => {
    process.env.NEXT_PUBLIC_APP_URL = origin;
    expect((await marketplaceCron(request())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects localhost in production even when explicitly configured', async () => {
    process.env = { ...process.env, NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3000' };
    expect((await marketplaceCron(request())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects authenticated URLs without exposing userinfo', async () => {
    const url = new URL('https://commerce.example.test');
    const user = randomBytes(12).toString('hex');
    const password = randomBytes(12).toString('hex');
    url.username = user; url.password = password;
    process.env.NEXT_PUBLIC_APP_URL = url.href;
    const response = await marketplaceCron(request());
    expect(response.status).toBe(503);
    const body = await response.text();
    for (const secret of [user, password, dispatchSecret, cronSecret]) expect(body).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('never retries a redirect, provider error or ambiguous network failure', async () => {
    fetchMock.mockRejectedValue(new Error(`${dispatchSecret} ${cronSecret}`));
    const response = await marketplaceCron(request());
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain(dispatchSecret); expect(body).not.toContain(cronSecret);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not follow a redirect that could receive the worker credential', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://other.example.test' } }));
    expect((await marketplaceCron(request())).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
  });
  it('aborts a long-running dispatch without automatically resubmitting it', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('timeout')));
    }));
    const pending = dispatchMarketFitWorker(request(), 'marketplace');
    await jest.advanceTimersByTimeAsync(270_001);
    expect((await pending).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed, oversized and failed worker responses without leaking their body', async () => {
    for (const response of [result({ refreshed: -1, unavailable: 0 }), result({ error: dispatchSecret }, 500),
      result({ refreshed: 1, unavailable: 0, credentials: dispatchSecret }),
      result({ payload: 'x'.repeat(70_000) })]) {
      fetchMock.mockResolvedValueOnce(response);
      const dispatched = await marketplaceCron(request());
      expect(dispatched.status).toBe(503);
      expect(await dispatched.text()).not.toContain(dispatchSecret);
    }
  });
  it('registers each moved schedule exactly once in API', () => {
    const config = JSON.parse(readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8'));
    expect(config.crons.filter((cron: {path: string}) => cron.path === '/api/cron/marketplace'))
      .toEqual([{ path: '/api/cron/marketplace', schedule: '* * * * *' }]);
    expect(config.crons.filter((cron: {path: string}) => cron.path === '/api/cron/credit-auto-top-up'))
      .toEqual([{ path: '/api/cron/credit-auto-top-up', schedule: '*/5 * * * *' }]);
  });
});