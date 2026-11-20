import { completeAuth, createAuthLink, getAccount, listAccounts, revokeAccount, verifyAccountIdentity } from '../composio-accounts';
import type { ComposioClient } from '../composio-transport';
import { accountFixture, secret } from './composio-fixtures';

describe('Composio bound account lifecycle adapter', () => {
  const request = jest.fn(); const client: ComposioClient = { request };
  const expected = { accountId: 'ca_one', userId: 'site_one', toolkitSlug: 'gmail', authConfigId: 'ac_one' };
  beforeEach(() => request.mockReset());

  it('returns only safe account identity and provider-granted scopes', async () => {
    const accessToken = secret(); const refreshToken = secret();
    const raw = accountFixture();
    request.mockResolvedValue({ ...raw, state: { val: { ...raw.state.val, access_token: accessToken, refresh_token: refreshToken } },
      credentials: { scope: 'email.admin' } });
    const result = await getAccount(client, 'ca_one');
    expect(result).toMatchObject({ id: 'ca_one', userId: 'site_one', toolkitSlug: 'gmail', authConfigId: 'ac_one', scopes: ['email.read', 'profile'] });
    for (const value of [accessToken, refreshToken, 'email.admin']) expect(JSON.stringify(result)).not.toContain(value);
  });

  it('normalizes absent, string, and array scopes without inventing access', async () => {
    request.mockResolvedValue({ ...accountFixture(), state: undefined });
    expect((await getAccount(client, 'ca_one')).scopes).toEqual([]);
    request.mockResolvedValue({ ...accountFixture(), state: { val: { scope: ['email.read', 'email.read'] } } });
    expect((await getAccount(client, 'ca_one')).scopes).toEqual(['email.read']);
    request.mockResolvedValue({ ...accountFixture(), state: { val: { scope: { malicious: 'scope' } } } });
    await expect(getAccount(client, 'ca_one')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('requires exact ID, toolkit, owner, config, active status and private account', async () => {
    const raw = accountFixture();
    for (const changed of [
      { id: 'ca_other' }, { toolkit: { slug: 'slack' } }, { user_id: 'another_site' },
      { auth_config: { id: 'ac_other', is_disabled: false } }, { auth_config: { id: 'ac_one', is_disabled: true } },
      { status: 'INITIATED' }, { experimental: { account_type: 'SHARED' } },
    ]) {
      request.mockResolvedValue({ ...raw, ...changed });
      await expect(verifyAccountIdentity(client, expected)).rejects.toBeDefined();
    }
  });

  it('proves omitted deprecated user_id using one exact account plus user-filtered list', async () => {
    const { user_id: _, ...raw } = accountFixture();
    request.mockResolvedValueOnce(raw).mockResolvedValueOnce({ items: [raw], next_cursor: null });
    expect((await verifyAccountIdentity(client, expected)).id).toBe('ca_one');
    expect(request).toHaveBeenNthCalledWith(2, '/connected_accounts?user_ids=site_one&connected_account_ids=ca_one&limit=1');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not infer ownership from a project-wide account when owner proof is missing', async () => {
    const { user_id: _, ...raw } = accountFixture();
    request.mockResolvedValueOnce(raw).mockResolvedValueOnce({ items: [], next_cursor: null });
    await expect(verifyAccountIdentity(client, expected)).rejects.toMatchObject({ code: 'CONNECTOR_ACCOUNT_MISMATCH' });
  });

  it('lists only one user-filtered page; never adopts or fetches all project accounts', async () => {
    request.mockResolvedValue({ items: [accountFixture()], next_cursor: 'next_page' });
    expect((await listAccounts(client, 'site_one')).next_cursor).toBe('next_page');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toContain('user_ids=site_one');
    request.mockResolvedValue({ items: [{ ...accountFixture(), user_id: 'foreign_site' }] });
    await expect(listAccounts(client, 'site_one')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('creates an OAuth link with exact identity and trusted callback, drops link_token', async () => {
    const token = secret(); const expiresAt = new Date(Date.now() + 60_000).toISOString();
    request.mockResolvedValue({ connected_account_id: 'ca_one', redirect_url: 'https://connect.composio.dev/link', expires_at: expiresAt, link_token: token });
    const result = await createAuthLink(client, { authConfigId: 'ac_one', userId: 'site_one', callbackUrl: 'https://app.example.test/connectors/callback' });
    expect(result).toEqual({ accountId: 'ca_one', redirectUrl: 'https://connect.composio.dev/link', expiresAt });
    expect(request).toHaveBeenCalledWith('/connected_accounts/link', { method: 'POST', body: {
      auth_config_id: 'ac_one', user_id: 'site_one', callback_url: 'https://app.example.test/connectors/callback',
    } });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each(['http://app.example.test/connectors/callback', 'https://app.example.test/other', 'https://app.example.test/connectors/callback?attempt=forged'])
    ('rejects noncanonical callback %s before initiation', async callbackUrl => {
      await expect(createAuthLink(client, { authConfigId: 'ac_one', userId: 'site_one', callbackUrl })).rejects.toMatchObject({ code: 'CONNECTOR_INVALID_INPUT' });
      expect(request).not.toHaveBeenCalled();
    });

  it.each(['https://attacker.test/oauth', 'http://connect.composio.dev/link', 'https://connect.composio.dev:444/link'])
    ('treats an unsafe provider redirect %s as unknown outcome, not a retry', async redirect_url => {
      request.mockResolvedValue({ connected_account_id: 'ca_one', redirect_url, expires_at: new Date(Date.now() + 60_000).toISOString() });
      await expect(createAuthLink(client, { authConfigId: 'ac_one', userId: 'site_one', callbackUrl: 'https://app.example.test/connectors/callback' }))
        .rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN' });
      expect(request).toHaveBeenCalledTimes(1);
    });

  it('redeems opaque callback proof once, only as JSON at complete_auth, without following it', async () => {
    const proof = new URL('https://callback.example.test/opaque'); proof.searchParams.set('session', secret());
    request.mockResolvedValue({ connected_account_id: 'ca_one', toolkit_slug: 'gmail' });
    expect(await completeAuth(client, { sessionUri: proof.toString(), userId: 'site_one' })).toEqual({ accountId: 'ca_one', toolkitSlug: 'gmail' });
    expect(request).toHaveBeenCalledWith('/connected_accounts/complete_auth', { method: 'POST', body: { session_uri: proof.toString(), user_id: 'site_one' } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never accepts status-success or connectedAccountId as callback identity fallback', async () => {
    request.mockResolvedValue({ status: 'success', connectedAccountId: 'ca_one', toolkit_slug: 'gmail' });
    await expect(completeAuth(client, { sessionUri: secret(), userId: 'site_one' })).rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN' });
  });

  it('confirms exact revoked account through documented revoke, never delete fallback', async () => {
    request.mockResolvedValue({ revoked_tokens: ['access_token'], connected_account: { id: 'ca_one', status: 'REVOKED' } });
    expect(await revokeAccount(client, 'ca_one')).toEqual({ id: 'ca_one', status: 'REVOKED' });
    expect(request).toHaveBeenCalledWith('/connected_accounts/ca_one/revoke', { method: 'POST' });
    request.mockResolvedValue({ revoked_tokens: [], connected_account: { id: 'ca_other', status: 'REVOKED' } });
    await expect(revokeAccount(client, 'ca_one')).rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN' });
    request.mockResolvedValue({ success: true, revoke_job_id: 'job' });
    await expect(revokeAccount(client, 'ca_one')).rejects.toMatchObject({ code: 'CONNECTOR_OUTCOME_UNKNOWN' });
  });
});