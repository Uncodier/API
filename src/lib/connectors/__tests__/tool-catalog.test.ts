import { randomBytes } from 'node:crypto';
import { getToolkitToolCatalog, listToolkitTools } from '../tool-catalog';
import { GET } from '@/app/api/connectors/catalog/[slug]/tools/route';
import { ConnectorError } from '../types';

const access = jest.fn(), credential = jest.fn(), request = jest.fn(), getUser = jest.fn();
jest.mock('../access', () => ({
  requireConnectorSiteAccess: (...args: unknown[]) => access(...args),
  loadConnectorCredential: (...args: unknown[]) => credential(...args),
}));
jest.mock('../composio-transport', () => ({ ...jest.requireActual('../composio-transport'),
  createComposioClient: () => ({ request }),
}));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { auth: { getUser: (...args: unknown[]) => getUser(...args) } } }));
const site = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const tool = { slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch emails', is_deprecated: false, description: 'Read messages.', toolkit: { slug: 'gmail' } };
const token = randomBytes(24).toString('hex');
beforeEach(() => {
  jest.clearAllMocks(); access.mockResolvedValue({ can_view: true });
  credential.mockResolvedValue({ apiKey: token });
  getUser.mockResolvedValue({ data: { user: { id: user } }, error: null });
  request.mockResolvedValue({ items: [tool], next_cursor: 'next', total_items: 61 });
});

it('projects real metadata, strips schemas/secrets, and treats review as distinct from execution', async () => {
  request.mockResolvedValue({ items: [{ ...tool, input_parameters: { private: token } },
    { ...tool, slug: 'GMAIL_SEND_EMAIL' }], next_cursor: 'next', total_items: 61 });
  const result = await listToolkitTools({ request }, 'gmail');
  expect(result).toMatchObject({ total: 61, next_cursor: 'next', items: [{ reviewed: true }, { reviewed: false }] });
  expect(JSON.stringify(result)).not.toContain(token);
  expect(result.items[0]).not.toHaveProperty('input_parameters');
  expect(result.items[0]).not.toHaveProperty('can_execute');
  expect(request.mock.calls[0][0]).toBe('/tools?toolkit_slug=gmail&limit=20&include_deprecated=false');
});

it('scopes continuation and rejects foreign toolkits or repeated cursors', async () => {
  await listToolkitTools({ request }, 'gmail', 'page-one');
  expect(request.mock.calls[0][0]).toContain('cursor=page-one');
  request.mockResolvedValueOnce({ items: [{ ...tool, toolkit: { slug: 'github' } }] });
  await expect(listToolkitTools({ request }, 'gmail')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  await expect(listToolkitTools({ request }, 'gmail', 'next')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
});

it('checks actor/site authority before reading credentials or provider metadata', async () => {
  access.mockRejectedValueOnce(new ConnectorError('ACCESS_DENIED', 'Denied.', 403));
  await expect(getToolkitToolCatalog(user, 'gmail', { site_id: site })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(credential).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});

it('jumps to the last numbered tools page while preserving site admission', async () => {
  request.mockResolvedValueOnce({ items: [tool], next_cursor: null, total_items: 61 });
  const result = await getToolkitToolCatalog(user, 'gmail', { site_id: site, page: 4 });
  expect(result).toMatchObject({ current_page: 4, total_pages: 4, has_next: false });
  const query = new URLSearchParams(request.mock.calls[0][0].split('?')[1]);
  expect(Buffer.from(query.get('cursor')!, 'base64').toString()).toBe('4-20');
  expect(access).toHaveBeenCalledWith(site, user);
});

it('route verifies bearer, validates query and returns private read-only metadata', async () => {
  const context = { params: Promise.resolve({ slug: 'gmail' }) };
  const url = `https://api.example.test/api/connectors/catalog/gmail/tools?site_id=${site}`;
  expect((await GET(new Request(url), context)).status).toBe(401);
  expect(request).not.toHaveBeenCalled();
  const headers = { authorization: `Bearer ${token}` };
  expect((await GET(new Request(`${url}&user_id=${user}`, { headers }), context)).status).toBe(400);
  expect((await GET(new Request(`${url}&site_id=${site}`, { headers }), context)).status).toBe(400);
  const response = await GET(new Request(url, { headers }), context);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(access).toHaveBeenCalledWith(site, user);
  expect(await response.json()).toMatchObject({ items: [{ slug: tool.slug }] });
});

it('searches the provider catalogue before pagination, scoped to the toolkit and workspace', async () => {
  const term = 'invoice & mail';
  const context = { params: Promise.resolve({ slug: 'gmail' }) };
  const headers = { authorization: `Bearer ${token}` };
  const url = `https://api.example.test/api/connectors/catalog/gmail/tools?site_id=${site}`;
  const response = await GET(new Request(`${url}&q=${encodeURIComponent(term)}&page=2`, { headers }), context);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ items: [{ slug: tool.slug, reviewed: true }], current_page: 2 });
  expect(credential).toHaveBeenCalledWith(site);
  expect(Object.fromEntries(new URLSearchParams(request.mock.calls[0][0].split('?')[1]))).toEqual({
    toolkit_slug: 'gmail', include_deprecated: 'false', limit: '20', cursor: Buffer.from('2-20').toString('base64'), query: term,
  });
  for (const q of ['', '%0A', 'a'.repeat(201), 'x&q=y']) {
    expect((await GET(new Request(`${url}&q=${q}`, { headers }), context)).status).toBe(400);
  }
  expect(request).toHaveBeenCalledTimes(1);
});
