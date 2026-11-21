import { GET as list } from '@/app/api/public/integrations/route';
import { GET as detail } from '@/app/api/public/integrations/[slug]/route';
import { GET as tools } from '@/app/api/public/integrations/[slug]/tools/route';
import { jsonResponse, secret, toolkitFixture, toolFixture } from './composio-fixtures';

jest.mock('next/cache', () => ({ unstable_cache: (load: unknown) => load }));
jest.mock('../access', () => { throw new Error('Public catalogue imported tenant access'); });

const path = '/api/public/integrations';
const req = (suffix = '', headers?: HeadersInit) => new Request(`https://example.test${path}${suffix}`, { headers });
const context = (slug = 'gmail') => ({ params: Promise.resolve({ slug }) });
const fetchMock = jest.spyOn(global, 'fetch');
const originalKey = process.env.COMPOSIO_PUBLIC_CATALOG_API_KEY;
const providerKey = secret();

beforeEach(() => {
  fetchMock.mockReset();
  process.env.COMPOSIO_PUBLIC_CATALOG_API_KEY = providerKey;
});
afterAll(() => {
  if (originalKey === undefined) delete process.env.COMPOSIO_PUBLIC_CATALOG_API_KEY;
  else process.env.COMPOSIO_PUBLIC_CATALOG_API_KEY = originalKey;
  fetchMock.mockRestore();
});

it('applies the shared multi-domain mapping and returns display fields only', async () => {
  const hubspot = { ...toolkitFixture(), slug: 'hubspot', name: 'HubSpot', auth_config_id: providerKey };
  fetchMock.mockResolvedValueOnce(jsonResponse({ items: [toolkitFixture(), hubspot] }));
  const response = await list(req('?q=hub&category=marketing', { authorization: `Bearer ${secret()}`, cookie: `session=${secret()}` }));
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.items).toEqual([{
    slug: 'hubspot', name: 'HubSpot', description: 'Email toolkit.', logo: 'https://logos.composio.dev/api/gmail', tools_count: 12,
    domains: ['crm', 'marketing'],
  }]);
  expect(body.domains[0]).toEqual({ id: 'ai', label: 'Artificial Intelligence' });
  expect(JSON.stringify(body)).not.toContain(providerKey);
  expect(JSON.stringify(body)).not.toContain('auth_schemes');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const [url, init] = fetchMock.mock.calls[0];
  expect(new URL(String(url)).searchParams.get('type')).toBe('native');
  expect(new Headers(init?.headers).get('x-api-key')).toBe(providerKey);
  expect(new Headers(init?.headers).has('authorization')).toBe(false);
  expect(new Headers(init?.headers).has('cookie')).toBe(false);
});

it.each(['?site_id=x', '?cursor=x', '?page=1&page=2', '?page=1000', '?category=unknown', '?__proto__=x'])('rejects %s before reaching the provider', async query => {
  expect((await list(req(query))).status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('paginates after domain filtering and maintains provider order', async () => {
  const gmail = toolkitFixture();
  const items = Array.from({ length: 51 }, (_, i) => ({ ...gmail, slug: `email_${i}` }));
  fetchMock.mockResolvedValueOnce(jsonResponse({ items: [...items, { ...gmail, slug: 'stripe' }] }));
  const response = await list(req('?category=communication&page=2'));
  const body = await response.json();
  expect(body).toMatchObject({ total: 51, current_page: 2, total_pages: 2, has_next: false });
  expect(body.items.map((item: { slug: string }) => item.slug)).toEqual(['email_50']);
  expect(body).not.toHaveProperty('next_cursor');
});

it('shows native detail and paginated tool text without schemas, review metadata or cursor', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(toolkitFixture()));
  const response = await detail(req('/gmail'), context());
  expect(response.headers.get('Cache-Control')).toMatch(/^public/);
  expect((await response.json()).toolkit).toEqual(expect.objectContaining({ slug: 'gmail', domains: ['communication'] }));

  fetchMock.mockResolvedValueOnce(jsonResponse(toolkitFixture())).mockResolvedValueOnce(jsonResponse({
    items: [{ ...toolFixture(), name: 'Fetch emails', tags: ['readOnlyHint', providerKey], input_parameters: { private: providerKey } }], next_cursor: 'opaque', total_items: 61,
  }));
  const toolResponse = await tools(req('/gmail/tools?page=2'), context());
  const data = await toolResponse.json();
  expect(data).toEqual({ items: [{ slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch emails', description: 'Fetch authorized messages.', action_types: ['read'] }],
    total: 61, current_page: 2, total_pages: 4, has_next: true });
  expect(JSON.stringify(data)).not.toContain(providerKey);
  expect(new URL(String(fetchMock.mock.calls[2][0])).searchParams.get('include_deprecated')).toBe('false');
});

it('accepts only known action types for tools and paginates the tag-filtered public catalogue', async () => {
  expect((await tools(req('/gmail/tools?action=invalid'), context())).status).toBe(400);
  expect((await detail(req('/gmail?action=read'), context())).status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce(jsonResponse(toolkitFixture())).mockResolvedValueOnce(jsonResponse({
    items: [{ ...toolFixture(), name: 'Fetch emails', tags: ['readOnlyHint'] }], total_items: 22,
  }));
  const response = await tools(req('/gmail/tools?action=read&page=2'), context());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ total: 22, current_page: 2, total_pages: 2, items: [{ action_types: ['read'] }] });
  expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('tags')).toBe('readOnlyHint');
});

it('rejects malformed slugs, does not list custom tools, and hides provider errors', async () => {
  expect((await detail(req('/gmail'), context('../gmail'))).status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce(jsonResponse({ ...toolkitFixture(), type: 'custom' }));
  const custom = await tools(req('/gmail/tools'), context());
  expect(custom.status).toBe(503);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValueOnce(jsonResponse({ message: providerKey }, 404));
  const missing = await detail(req('/gmail'), context());
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: 'NOT_FOUND' });
  fetchMock.mockResolvedValueOnce(jsonResponse({ message: providerKey }, 401));
  expect(await (await list(req())).json()).toEqual({ error: 'CATALOG_UNAVAILABLE' });
});