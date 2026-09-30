import { describe, expect, it, jest } from '@jest/globals';
import {
  listConnectedAccounts,
  resolveSocialAccounts,
  SocialAccountResolutionError,
} from '../accounts';
import type { OutstandClient } from '../client';

const siteId = 'authorized-site';
const account = (overrides: Record<string, unknown> = {}) => ({
  id: 'opaque-account', network: 'instagram', username: 'name', isActive: 1,
  tenant_id: siteId, ...overrides,
});
const clientWith = (response: unknown) => ({
  listAccounts: jest.fn<OutstandClient['listAccounts']>().mockResolvedValue(response),
});
const rowsClient = (rows: unknown[]) => clientWith({ success: true, data: rows });

describe('listConnectedAccounts', () => {
  it('normalizes the observed provider payload and returns only safe account fields', async () => {
    const client = clientWith({
      success: true,
      data: [account({ accessToken: 'not-returned', metadata: { secret: 'not-returned' } })],
      count: 1, total: 1, limit: 100, offset: 0,
    });

    await expect(listConnectedAccounts(client, siteId)).resolves.toEqual([
      { id: 'opaque-account', network: 'instagram', username: 'name', isActive: true },
    ]);
    expect(client.listAccounts).toHaveBeenCalledWith(siteId, { tenantId: siteId, limit: 100, offset: 0 });
    expect(client.listAccounts).toHaveBeenCalledTimes(1);
  });

  it('normalizes the accounts envelope, network aliases, and numeric/boolean active flags', async () => {
    const client = clientWith({ success: true, accounts: [
      account({ id: 'one', network: 'Twitter', isActive: true }),
      account({ id: 'two', network: ' LinkedIn ', isActive: 0 }),
      account({ id: 'three', isActive: false }),
    ] });
    await expect(listConnectedAccounts(client, siteId)).resolves.toEqual([
      { id: 'one', network: 'x', username: 'name', isActive: true },
      { id: 'two', network: 'linkedin', username: 'name', isActive: false },
      { id: 'three', network: 'instagram', username: 'name', isActive: false },
    ]);
  });

  it('treats empty canonical data as authoritative over the legacy envelope', async () => {
    await expect(listConnectedAccounts(clientWith({
      success: true, data: [], accounts: [account()],
    }), siteId)).resolves.toEqual([]);
  });

  it.each(['', ' ', ' site ', null, undefined])('rejects an invalid trusted site before calling the provider: %s', async (value) => {
    const client = rowsClient([]);
    await expect(listConnectedAccounts(client, value as string)).rejects.toMatchObject({ code: 'INVALID_SITE_ID' });
    expect(client.listAccounts).not.toHaveBeenCalled();
  });

  it.each([
    { success: false, data: [] },
    { success: false, data: [account()] },
    { success: true, data: [], degraded: true },
    { success: true, data: [], error: 'Provider failure' },
  ])('does not mistake an upstream failure for an empty list: %j', async (response) => {
    await expect(listConnectedAccounts(clientWith(response), siteId)).rejects.toMatchObject({ code: 'ACCOUNT_PROVIDER_ERROR' });
  });

  it('wraps transport/HTTP errors without disclosing provider error data', async () => {
    const client = rowsClient([]);
    client.listAccounts.mockRejectedValue(new Error('sensitive provider error'));
    const failure = listConnectedAccounts(client, siteId);
    await expect(failure).rejects.toBeInstanceOf(SocialAccountResolutionError);
    await expect(failure).rejects.toMatchObject({ code: 'ACCOUNT_PROVIDER_ERROR' });
    await expect(failure).rejects.not.toThrow('sensitive');
  });

  it.each([
    null, [], 'not JSON', {}, { data: [] },
    { success: 'true', data: [] },
    { success: true },
    { success: true, accounts: {} },
    { success: true, data: null, accounts: [account()] },
    { success: true, data: {}, accounts: [account()] },
    { success: true, data: [null] },
    { success: true, data: ['not an account'] },
  ])('rejects a malformed envelope: %j', async (response) => {
    await expect(listConnectedAccounts(clientWith(response), siteId)).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_RESPONSE' });
  });

  it.each([
    { id: '' }, { id: 1 }, { username: null }, { username: ' ' },
    { network: '' }, { network: ' ' }, { network: 1 },
    { isActive: undefined }, { isActive: 'true' }, { isActive: '1' }, { isActive: 2 },
  ])('rejects malformed account fields: %j', async (overrides) => {
    await expect(listConnectedAccounts(rowsClient([account(overrides)]), siteId))
      .rejects.toMatchObject({ code: 'INVALID_ACCOUNT_RESPONSE' });
  });

  it.each([{ tenant_id: 'other-site' }, { tenant_id: undefined }, { tenant_id: null }, { tenantId: 'other-site' }])(
    'rejects the entire result for a foreign or unscoped row: %j', async (overrides) => {
      await expect(listConnectedAccounts(rowsClient([account(), account({ id: 'foreign', ...overrides })]), siteId))
        .rejects.toMatchObject({ code: 'ACCOUNT_SCOPE_MISMATCH' });
    },
  );

  it('reads every page using the trusted site, including short pages with a remaining total', async () => {
    const client = rowsClient([]);
    client.listAccounts
      .mockResolvedValueOnce({ success: true, data: [account()], count: 1, total: 2, limit: 100, offset: 0 })
      .mockResolvedValueOnce({ success: true, accounts: [account({ id: 'second' })], count: 1, total: 2, limit: 100, offset: 1 });
    await expect(listConnectedAccounts(client, siteId)).resolves.toHaveLength(2);
    expect(client.listAccounts).toHaveBeenNthCalledWith(2, siteId, { tenantId: siteId, limit: 100, offset: 1 });
  });

  it('continues full pages without a total until the provider returns a short page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => account({ id: `id-${index}` }));
    const client = rowsClient([]);
    client.listAccounts.mockResolvedValueOnce({ success: true, data: firstPage });
    await expect(listConnectedAccounts(client, siteId)).resolves.toHaveLength(100);
    expect(client.listAccounts).toHaveBeenNthCalledWith(2, siteId, { tenantId: siteId, limit: 100, offset: 100 });
  });

  it('fails instead of returning partial results if a later page fails', async () => {
    const client = clientWith({ success: false });
    client.listAccounts.mockResolvedValueOnce({ success: true, data: [account()], total: 2 });
    await expect(listConnectedAccounts(client, siteId)).rejects.toMatchObject({ code: 'ACCOUNT_PROVIDER_ERROR' });
  });

  it.each([
    { total: '1' }, { total: -1 }, { total: 0 }, { count: 2 },
    { limit: 0 }, { limit: 101 }, { offset: 1 }, { count: 1.5 },
  ])('rejects malformed or inconsistent pagination metadata: %j', async (metadata) => {
    await expect(listConnectedAccounts(clientWith({ success: true, data: [account()], ...metadata }), siteId))
      .rejects.toMatchObject({ code: 'INVALID_ACCOUNT_RESPONSE' });
  });

  it('fails when an empty page contradicts the known total', async () => {
    const client = clientWith({ success: true, data: [], total: 2 });
    client.listAccounts.mockResolvedValueOnce({ success: true, data: [account()], total: 2 });
    await expect(listConnectedAccounts(client, siteId)).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_RESPONSE' });
  });

  it('fails when totals change during pagination', async () => {
    const client = clientWith({ success: true, data: [account({ id: 'second' })], total: 3 });
    client.listAccounts.mockResolvedValueOnce({ success: true, data: [account()], total: 2 });
    await expect(listConnectedAccounts(client, siteId)).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_RESPONSE' });
  });

  it('fails on repeated IDs rather than accepting ignored pagination or conflicting rows', async () => {
    const client = clientWith({ success: true, data: [account()], total: 2 });
    await expect(listConnectedAccounts(client, siteId)).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_RESPONSE' });
    expect(client.listAccounts).toHaveBeenCalledTimes(2);
  });

  it('bounds pagination and never returns a truncated success', async () => {
    const client = rowsClient([]);
    client.listAccounts.mockImplementation(async (_site, params) => ({
      success: true, data: [account({ id: `id-${params?.offset}` })], limit: 1,
    }));
    await expect(listConnectedAccounts(client, siteId)).rejects.toMatchObject({ code: 'ACCOUNT_PAGINATION_LIMIT' });
    expect(client.listAccounts).toHaveBeenCalledTimes(20);
  });
});

describe('resolveSocialAccounts', () => {
  it('uses exact opaque ID before username and platform namespaces', async () => {
    const client = rowsClient([
      account({ id: 'instagram', network: 'facebook', username: 'id-owner' }),
      account({ id: 'other', network: 'x', username: 'instagram' }),
      account({ id: 'network-match' }),
    ]);
    await expect(resolveSocialAccounts(client, siteId, ['instagram'])).resolves.toEqual([
      { id: 'instagram', network: 'facebook', username: 'id-owner', isActive: true },
    ]);
  });

  it('uses an exact username before a platform name', async () => {
    const client = rowsClient([
      account({ id: 'username-owner', username: 'instagram', network: 'x' }),
      account({ id: 'network-owner' }),
    ]);
    await expect(resolveSocialAccounts(client, siteId, ['instagram'])).resolves.toEqual([
      { id: 'username-owner', network: 'x', username: 'instagram', isActive: true },
    ]);
  });

  it('normalizes legacy platform selectors and deduplicates IDs in selection order', async () => {
    const client = rowsClient([account({ network: 'twitter' }), account({ id: 'second', username: 'second-name' })]);
    const result = await resolveSocialAccounts(client, siteId, ['opaque-account', ' X ', 'name', 'Twitter', 'second']);
    expect(result.map((row) => row.id)).toEqual(['opaque-account', 'second']);
    expect(client.listAccounts).toHaveBeenCalledTimes(1);
  });

  it('treats opaque IDs and usernames as case-sensitive exact identifiers', async () => {
    await expect(resolveSocialAccounts(rowsClient([account()]), siteId, ['NAME']))
      .rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    await expect(resolveSocialAccounts(rowsClient([account()]), siteId, ['OPAQUE-ACCOUNT']))
      .rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('selects the only active platform account rather than inactive siblings', async () => {
    const client = rowsClient([account(), account({ id: 'inactive', isActive: 0 })]);
    const result = await resolveSocialAccounts(client, siteId, ['Instagram']);
    expect(result.map((row) => row.id)).toEqual(['opaque-account']);
  });

  it('preserves newly supported provider networks without blocking known accounts', async () => {
    const client = rowsClient([account(), account({ id: 'vimeo-account', network: ' Vimeo ' })]);
    const result = await resolveSocialAccounts(client, siteId, ['Instagram', 'Vimeo']);
    expect(result.map((row) => ({ id: row.id, network: row.network }))).toEqual([
      { id: 'opaque-account', network: 'instagram' }, { id: 'vimeo-account', network: 'vimeo' },
    ]);
  });

  it.each(['instagram', 'name'])('rejects ambiguous platform or username matches: %s', async (selector) => {
    const client = rowsClient([account(), account({ id: 'second' })]);
    await expect(resolveSocialAccounts(client, siteId, [selector])).rejects.toMatchObject({ code: 'ACCOUNT_AMBIGUOUS' });
  });

  it.each(['opaque-account', 'name', 'Instagram'])('rejects inactive ID, username, or platform matches: %s', async (selector) => {
    await expect(resolveSocialAccounts(rowsClient([account({ isActive: false })]), siteId, [selector]))
      .rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
  });

  it('does not fall back from an inactive exact ID to an active username or platform', async () => {
    const client = rowsClient([
      account({ id: 'instagram', isActive: false }),
      account({ id: 'other', username: 'instagram' }),
    ]);
    await expect(resolveSocialAccounts(client, siteId, ['instagram'])).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
  });

  it('does not fall back from an inactive exact username to an active platform', async () => {
    const client = rowsClient([
      account({ id: 'inactive', username: 'instagram', network: 'x', isActive: false }), account(),
    ]);
    await expect(resolveSocialAccounts(client, siteId, ['instagram'])).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
  });

  it.each([['opaque-account', 'missing'], ['missing'], ['constructor'], ['__proto__']].map((selectors) => ({ selectors })))(
    'rejects all selectors rather than returning partial targets: %j', async ({ selectors }) => {
      await expect(resolveSocialAccounts(rowsClient([account()]), siteId, selectors))
        .rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    },
  );

  it('requires complete discovery before accepting an early ID match', async () => {
    const client = clientWith({ success: true, data: [account({ id: 'foreign', tenant_id: 'other' })], total: 2 });
    client.listAccounts.mockResolvedValueOnce({ success: true, data: [account()], total: 2 });
    await expect(resolveSocialAccounts(client, siteId, ['opaque-account']))
      .rejects.toMatchObject({ code: 'ACCOUNT_SCOPE_MISMATCH' });
  });

  it.each([null, undefined, [], 'instagram', [''], [' '], [12], Array(1), Array(101).fill('id')].map((selectors) => ({ selectors })))(
    'validates selector input before requesting accounts: %j', async ({ selectors }) => {
      const client = rowsClient([]);
      await expect(resolveSocialAccounts(client, siteId, selectors as string[]))
        .rejects.toMatchObject({ code: 'INVALID_ACCOUNT_SELECTORS' });
      expect(client.listAccounts).not.toHaveBeenCalled();
    },
  );
});