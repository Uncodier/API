import { getToolkit, listAuthConfigs, listToolkits } from '../composio-catalog';
import type { ComposioClient } from '../composio-transport';
import { secret, toolkitFixture } from './composio-fixtures';

describe('Composio catalogue normalization', () => {
  const request = jest.fn();
  const client: ComposioClient = { request };
  beforeEach(() => request.mockReset());

  it('normalizes metadata and truthful pagination without returning raw fields', async () => {
    const credential = secret();
    request.mockResolvedValue({ items: [{ ...toolkitFixture(), credentials: credential }], next_cursor: 'next_page', total_items: 700 });
    const result = await listToolkits(client, { query: 'gmail&extra=true', category: 'communication', limit: 10 });
    expect(result).toMatchObject({ total_items: 700, next_cursor: 'next_page', items: [{
      slug: 'gmail', description: 'Email toolkit.', tools_count: 12, auth_schemes: ['OAUTH2'],
    }] });
    expect(request).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(request.mock.calls[0][0].split('?')[1]);
    expect(params.get('search')).toBe('gmail&extra=true');
    expect(params.has('extra')).toBe(false);
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it('does not invent totals or follow cursors automatically', async () => {
    request.mockResolvedValue({ items: [], next_cursor: 'next_page' });
    expect(await listToolkits(client)).toEqual({ items: [], next_cursor: 'next_page', total_items: null });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('normalizes live v3.1 category IDs for both catalogue and toolkit detail', async () => {
    const toolkit = toolkitFixture();
    const live = { ...toolkit, meta: { ...toolkit.meta, categories: [{ id: 'email', name: 'Email' }, { id: 'scheduling-&-booking', name: 'Scheduling & Booking' }] } };
    const expected = [{ slug: 'email', name: 'Email' }, { slug: 'scheduling-&-booking', name: 'Scheduling & Booking' }];
    request.mockResolvedValueOnce({ items: [live], next_cursor: null, total_items: 1 });
    expect((await listToolkits(client)).items[0].categories).toEqual(expected);
    request.mockResolvedValueOnce(live);
    expect((await getToolkit(client, 'gmail')).categories).toEqual(expected);
  });

  it.each([{ name: 'Email' }, { id: '../email', name: 'Email' }, { id: 123, name: 'Email' }])
    ('rejects missing or malformed category identifiers (%#)', async category => {
      const toolkit = toolkitFixture();
      request.mockResolvedValue({ items: [{ ...toolkit, meta: { ...toolkit.meta, categories: [category] } }] });
      await expect(listToolkits(client)).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    });

  it('accepts Google Calendar detail category slugs containing ampersands', async () => {
    const toolkit = toolkitFixture();
    request.mockResolvedValue({ ...toolkit, slug: 'googlecalendar', meta: { ...toolkit.meta,
      categories: [{ slug: 'scheduling-&-booking', name: 'Scheduling & Booking' }] } });
    expect((await getToolkit(client, 'googlecalendar')).categories).toEqual([
      { slug: 'scheduling-&-booking', name: 'Scheduling & Booking' },
    ]);
  });

  it('includes API-key capability from detailed metadata even when OAuth is advertised separately', async () => {
    request.mockResolvedValue({ ...toolkitFixture(), slug: 'supabase', auth_schemes: ['OAUTH2'],
      auth_config_details: [{ mode: 'API_KEY' }], composio_managed_auth_schemes: ['OAUTH2'] });
    expect((await getToolkit(client, 'supabase')).auth_schemes).toEqual(['OAUTH2', 'API_KEY']);
  });

  it.each(['../email', 'https://foreign.test', 'mail\nheader'])('rejects unsafe detail category slugs (%#)', async slug => {
    const toolkit = toolkitFixture();
    request.mockResolvedValue({ ...toolkit, meta: { ...toolkit.meta, categories: [{ slug, name: 'Email' }] } });
    await expect(getToolkit(client, 'gmail')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it.each(['https://attacker.test/image', 'http://logos.composio.dev/logo', 'https://logos.composio.dev:444/logo'])
    ('removes untrusted logo %s without loading it', async logo => {
      const toolkit = toolkitFixture(); toolkit.meta.logo = logo;
      request.mockResolvedValue(toolkit);
      expect((await getToolkit(client, 'gmail')).logo_url).toBeNull();
    });

  it('strips unsafe authenticated/query logo URLs and keeps a supported static logo', async () => {
    const credential = secret(); const url = new URL('https://logos.composio.dev/logo');
    url.username = 'user'; url.password = credential;
    const toolkit = toolkitFixture(); toolkit.meta.logo = url.toString();
    request.mockResolvedValue(toolkit);
    const result = await getToolkit(client, 'gmail');
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(result.logo_url).toBeNull();
    request.mockResolvedValue(toolkitFixture());
    expect((await getToolkit(client, 'gmail')).logo_url).toBe('https://logos.composio.dev/api/gmail');
  });

  it('supports detail auth_config_details without exposing auth fields or proxy URLs', async () => {
    const { auth_schemes: _, ...toolkit } = toolkitFixture();
    const credential = secret();
    request.mockResolvedValue({ ...toolkit, enabled: true, auth_config_details: [{ mode: 'OAUTH2', fields: { secret: credential } }] });
    const result = await getToolkit(client, 'gmail');
    expect(result.auth_schemes).toEqual(['OAUTH2']);
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it('fails closed on wrong toolkit identity, custom toolkits and malformed pages', async () => {
    for (const value of [{ ...toolkitFixture(), slug: 'slack' }, { ...toolkitFixture(), type: 'custom' }, { slug: 'gmail' }]) {
      request.mockResolvedValue(value);
      await expect(getToolkit(client, 'gmail')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    }
    request.mockResolvedValue({ items: [toolkitFixture(), toolkitFixture()] });
    await expect(listToolkits(client, { limit: 1 })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('validates slug, filters, cursors, and page limits before network', async () => {
    await expect(getToolkit(client, '../accounts')).rejects.toMatchObject({ code: 'CONNECTOR_INVALID_INPUT' });
    await expect(listToolkits(client, { limit: 1000 })).rejects.toMatchObject({ code: 'CONNECTOR_INVALID_INPUT' });
    await expect(listToolkits(client, { cursor: '\n' })).rejects.toMatchObject({ code: 'CONNECTOR_INVALID_INPUT' });
    expect(request).not.toHaveBeenCalled();
  });

  it('lists safe enabled auth configs only and never leaks requested credential scope ceilings', async () => {
    const credential = secret();
    request.mockResolvedValue({ items: [{
      id: 'ac_one', name: 'OAuth', toolkit: { slug: 'gmail' }, auth_scheme: 'OAUTH2', status: 'ENABLED',
      credentials: { client_secret: credential, scopes: 'email.write' }, shared_connection_fields: { token: credential },
    }], next_cursor: null, total_items: 1 });
    const result = await listAuthConfigs(client, 'gmail');
    expect(result.items).toEqual([{ id: 'ac_one', name: 'OAuth', toolkitSlug: 'gmail', authScheme: 'OAUTH2', status: 'ENABLED' }]);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain('email.write');
    expect(request.mock.calls[0][0]).toContain('toolkit_slug=gmail');
  });

  it.each(['DISABLED', 'BROKEN'])('refuses provider auth-config status %s', async status => {
    request.mockResolvedValue({ items: [{ id: 'ac_one', name: 'OAuth', toolkit: { slug: 'gmail' }, status }] });
    await expect(listAuthConfigs(client, 'gmail')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });
});