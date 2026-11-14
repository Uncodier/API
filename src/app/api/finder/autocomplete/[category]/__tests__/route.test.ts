import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { GET } from '../route';

jest.mock('@/lib/utils/api-response-utils', () => ({ logInfo: jest.fn(), logError: jest.fn() }));

const previousAccount = process.env.FORAGER_ACCOUNT_ID;
const previousKey = process.env.FORAGER_API_KEY;
const originalFetch = global.fetch;
const context = (category = 'organizations') => ({ params: Promise.resolve({ category }) });
const request = (query = 'q=Apple&page=1') => new NextRequest(`http://localhost:3001/api/finder/autocomplete/organizations?${query}`);

beforeEach(() => {
  process.env.FORAGER_ACCOUNT_ID = 'test-account';
  process.env.FORAGER_API_KEY = randomBytes(32).toString('hex');
  global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
    results: [{ id: '135580', text: 'Apple - apple.com' }], pagination: { more: true },
  }), { headers: { 'content-type': 'application/json' } }));
});

afterEach(() => {
  global.fetch = originalFetch;
  if (previousAccount === undefined) delete process.env.FORAGER_ACCOUNT_ID;
  else process.env.FORAGER_ACCOUNT_ID = previousAccount;
  if (previousKey === undefined) delete process.env.FORAGER_API_KEY;
  else process.env.FORAGER_API_KEY = previousKey;
});

it.each(['Apple', 'Microsoft'])('uses authenticated account autocomplete for company name %s', async name => {
  const response = await GET(request(`q=${name}&page=1`), context());
  expect(response.status).toBe(200);
  expect(fetch).toHaveBeenCalledWith(
    `https://api-v2.forager.ai/api/test-account/datastorage/autocomplete/organizations/?page=1&q=${name}`,
    expect.objectContaining({ headers: { 'X-API-KEY': process.env.FORAGER_API_KEY }, cache: 'no-store' }),
  );
  expect(await response.json()).toMatchObject({ results: [{ id: '135580' }] });
});

it.each(['page=0', 'page=1', 'page=invalid', ''])('starts at the first valid page for %s', async page => {
  await GET(request(`q=Apple&${page}`), context());
  expect(String(jest.mocked(fetch).mock.calls[0][0])).toContain('?page=1&q=Apple');
});

it.each(['industries', 'organizations', 'organization_keywords', 'locations', 'person_skills', 'web_technologies'])(
  'authenticates category %s without a public fallback', async category => {
    await GET(request(), context(category));
    expect(String(jest.mocked(fetch).mock.calls[0][0])).toContain(`/api/test-account/datastorage/autocomplete/${category}/`);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it.each(['FORAGER_ACCOUNT_ID', 'FORAGER_API_KEY'])('fails closed without %s', async variable => {
  delete process.env[variable];
  expect((await GET(request(), context())).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects unsupported categories', async () => {
  expect((await GET(request(), context('invalid'))).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});

it('does not expose upstream errors or credentials', async () => {
  jest.mocked(fetch).mockResolvedValue(new Response(process.env.FORAGER_API_KEY, { status: 401 }));
  const response = await GET(request(), context());
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain(process.env.FORAGER_API_KEY!);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([{}, { results: null }])('rejects malformed response %j', async body => {
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  expect((await GET(request(), context())).status).toBe(502);
});

it('returns a recoverable error on timeout or network failure', async () => {
  jest.mocked(fetch).mockRejectedValue(new Error(process.env.FORAGER_API_KEY));
  const response = await GET(request(), context());
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain(process.env.FORAGER_API_KEY!);
});