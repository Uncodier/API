/** @jest-environment node */
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: jest.fn(), auth: { getUser: jest.fn() } },
}));

import { supabaseAdmin } from '@/lib/database/supabase-client';
import { createCredentialRevalidation } from '../credential-revalidation';
import { createRevalidation } from '../realtime-authorization';
import { credentialKey, credentialRow, restoreEnvironment } from './credential-fixtures';
import { database, ids } from './fixtures';

let fixture: ReturnType<typeof database>;
let row: Awaited<ReturnType<typeof credentialRow>>;
const previous = { ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, SERVICE_API_KEY: process.env.SERVICE_API_KEY };
const request = (headers: HeadersInit = { 'x-api-key': credentialKey }) => new Request('http://localhost/sse', { headers });

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'offline-realtime-key-encryption-secret';
  delete process.env.SERVICE_API_KEY;
  fixture = database();
  row = await credentialRow();
  fixture.state.apiKeys = [row];
  (supabaseAdmin.from as jest.Mock).mockImplementation(fixture.db.from);
  (supabaseAdmin.auth.getUser as jest.Mock).mockImplementation(fixture.db.auth.getUser);
});
afterAll(() => restoreEnvironment(previous));

it.each(['x-api-key', 'bearer', 'authorization'])('authenticates actual encrypted material from %s each time', async header => {
  const headers: Record<string, string> = header === 'x-api-key' ? { 'x-api-key': credentialKey }
    : { authorization: header === 'bearer' ? `Bearer ${credentialKey}` : credentialKey };
  const check = await createCredentialRevalidation(request(headers), ids.site);
  await check(); await check();
  expect(fixture.state.queries.filter(query => query.table === 'api_keys')).toHaveLength(3);
  expect(fixture.state.queries[0].filters).toContainEqual(['lookup_hash', row.lookup_hash]);
  expect(fixture.state.inserts).toHaveLength(0);
});

it.each(['revoked', 'expired', 'invalid-expiry', 'scope', 'site', 'owner', 'version', 'deleted', 'lookup', 'ciphertext'])(
  'rejects current credential %s after a successful check', async change => {
    const check = await createCredentialRevalidation(request(), ids.site);
    await check();
    if (change === 'revoked') row.status = 'revoked';
    if (change === 'expired') row.expires_at = new Date(Date.now() - 1).toISOString();
    if (change === 'invalid-expiry') row.expires_at = 'not-a-date';
    if (change === 'scope') row.scopes = ['identity:issue'];
    if (change === 'site') row.site_id = ids.other;
    if (change === 'owner') row.user_id = 'different-account';
    if (change === 'version') row.identity_token_version = ids.other;
    if (change === 'deleted') fixture.state.apiKeys = [];
    if (change === 'lookup') row.lookup_hash = 'different-hash';
    if (change === 'ciphertext') row.key_hash = (await credentialRow('key_other-secret')).key_hash;
    await expect(check()).rejects.toMatchObject({ status: 403 });
  },
);

it('requires exact encrypted proof even when its lookup hash matches', async () => {
  row.key_hash = (await credentialRow('key_not-the-presented-key')).key_hash;
  await expect(createCredentialRevalidation(request(), ids.site)).rejects.toMatchObject({ status: 403 });
});

it('preserves bounded legacy null-lookup support with exact proof and current status', async () => {
  row.lookup_hash = null;
  const check = await createCredentialRevalidation(request(), ids.site);
  row.status = 'revoked';
  await expect(check()).rejects.toMatchObject({ status: 403 });
  expect(fixture.state.queries.some(query => query.filters.some(([name]) => name === 'prefix'))).toBe(true);
});

it.each(['identity:issue', 'write'])('rejects %s-only credentials and accepts the existing wildcard', async scope => {
  row.scopes = [scope];
  await expect(createCredentialRevalidation(request(), ids.site)).rejects.toMatchObject({ status: 403 });
  row.scopes = ['*'];
  await expect(createCredentialRevalidation(request(), ids.site)).resolves.toEqual(expect.any(Function));
});

it('snapshots original credentials rather than rereading mutable proof or trusting forged principal metadata', async () => {
  const input = request({ 'x-api-key': credentialKey, 'x-api-key-data': JSON.stringify({ isService: true }) });
  const check = await createCredentialRevalidation(input, ids.site);
  input.headers.set('x-api-key', 'replacement');
  await check();
  row.status = 'revoked';
  await expect(check()).rejects.toMatchObject({ status: 403 });
});

it.each<Record<string, string>>([
  { 'x-api-key-data': JSON.stringify({ id: 'service-key', isService: true }) },
  { 'x-auth-validated': 'true', 'x-auth-user-id': 'user-1' },
])('rejects middleware-looking metadata without original proof: %j', async headers => {
  await expect(createRevalidation(request(headers), ids.site, null, null)).rejects.toMatchObject({ status: 403 });
});

it('does not let a session-bearing credential caller fall back to a browser grant after revocation', async () => {
  const input = request({ 'x-api-key': credentialKey, 'x-api-key-data': JSON.stringify({ site_id: ids.site }) });
  const check = await createRevalidation(input, ids.site, ids.session, {
    siteId: ids.site, sessionId: ids.session, visitorId: ids.visitor, leadId: ids.lead,
  });
  await check(ids.private);
  row.status = 'revoked';
  await expect(check(ids.private)).rejects.toMatchObject({ status: 403 });
});

it.each(['removed', 'rotated'])('rechecks SERVICE_API_KEY in the live environment when %s', async change => {
  process.env.SERVICE_API_KEY = 'current-service-key';
  const check = await createCredentialRevalidation(request({ authorization: 'Bearer current-service-key' }), ids.site);
  await check();
  if (change === 'removed') delete process.env.SERVICE_API_KEY;
  else process.env.SERVICE_API_KEY = 'next-service-key';
  await expect(check()).rejects.toMatchObject({ status: 403 });
});

it('closes a service identity that becomes a database identity for the same original material', async () => {
  process.env.SERVICE_API_KEY = credentialKey;
  const check = await createCredentialRevalidation(request(), ids.site);
  delete process.env.SERVICE_API_KEY;
  await expect(check()).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
});

it.each(['sites', 'site_ownership', 'site_members'])('checks current bearer auth and %s access without a positive cache', async table => {
  if (table === 'sites') fixture.state.sites = [{ id: ids.site, user_id: 'user-1' }];
  if (table === 'site_ownership') fixture.state.ownership = [{ site_id: ids.site, user_id: 'user-1' }];
  if (table === 'site_members') fixture.state.members = [{ site_id: ids.site, user_id: 'user-1', status: 'active' }];
  const check = await createCredentialRevalidation(request({ authorization: `Bearer ${fixture.state.bearer}` }), ids.site);
  await check();
  fixture.state.sites = []; fixture.state.ownership = []; fixture.state.members = [];
  await expect(check()).rejects.toMatchObject({ status: 403 });
  expect(fixture.db.auth.getUser).toHaveBeenCalledTimes(3);
  expect(fixture.db.auth.getUser).toHaveBeenLastCalledWith(fixture.state.bearer);
});

it.each(['revoked', 'expired', 'account-changed', 'site-transfer', 'provider-error'])(
  'rejects bearer %s and fixes its own authenticated principal snapshot', async change => {
    fixture.state.sites = [{ id: ids.site, user_id: 'user-1' }];
    const check = await createCredentialRevalidation(request({ authorization: `Bearer ${fixture.state.bearer}` }), ids.site);
    if (change === 'revoked') fixture.state.user = null;
    if (change === 'expired') fixture.state.userExpiresAt = Date.now() - 1;
    if (change === 'site-transfer') fixture.state.sites[0].user_id = 'user-2';
    if (change === 'provider-error') fixture.state.authError = true;
    if (change === 'account-changed') {
      fixture.state.user.id = 'user-2'; fixture.state.sites[0].user_id = 'user-2';
    }
    await expect(check()).rejects.toMatchObject({ status: 403 });
  },
);

it('applies current owner membership to unscoped database keys', async () => {
  row.site_id = null;
  fixture.state.members = [{ site_id: ids.site, user_id: 'user-1', status: 'active' }];
  const check = await createCredentialRevalidation(request(), ids.site);
  fixture.state.members[0].status = 'inactive';
  await expect(check()).rejects.toMatchObject({ status: 403 });
});

it('fails closed when credential storage becomes unavailable', async () => {
  const check = await createCredentialRevalidation(request(), ids.site);
  fixture.state.failedTable = 'api_keys';
  await expect(check()).rejects.toMatchObject({ status: 503 });
});

it.each(['api-key', 'bearer'])('rejects %s expiry during pending membership authorization', async kind => {
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    row.site_id = null;
    fixture.state.members = [{ site_id: ids.site, user_id: 'user-1', status: 'active' }];
    const input = kind === 'api-key' ? request() : request({ authorization: `Bearer ${fixture.state.bearer}` });
    const check = await createCredentialRevalidation(input, ids.site);
    fixture.state.resultHook = table => { if (table === 'site_members') clock.mockReturnValue(now + 120_000); };
    await expect(check()).rejects.toMatchObject({ status: 403 });
  } finally { clock.mockRestore(); }
});

it.each(['api-key', 'bearer', 'service'])('rechecks %s lifetime after awaited conversation authorization', async kind => {
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    fixture.state.sites = [{ id: ids.site, user_id: 'user-1' }];
    process.env.SERVICE_API_KEY = 'current-service-key';
    const input = kind === 'api-key' ? request() : request({ authorization: `Bearer ${kind === 'service'
      ? process.env.SERVICE_API_KEY : fixture.state.bearer}` });
    const check = await createRevalidation(input, ids.site, null, null);
    fixture.state.resultHook = table => {
      if (table === 'conversations') {
        clock.mockReturnValue(now + 120_000);
        delete process.env.SERVICE_API_KEY;
      }
    };
    await expect(check(ids.private)).rejects.toMatchObject({ status: 403 });
  } finally { clock.mockRestore(); }
});

it('closes a revoked then reactivated credential whose immutable version changed', async () => {
  const check = await createCredentialRevalidation(request(), ids.site);
  row.status = 'revoked'; row.identity_token_version = ids.other;
  row.status = 'active';
  await expect(check()).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
});

it.each([undefined, 'tomorrow', 0])('does not accept bearer JWTs without a current numeric expiry: %s', async exp => {
  fixture.state.bearer = `header.${btoa(JSON.stringify({ sub: 'user-1', exp }))}.signature`;
  fixture.state.sites = [{ id: ids.site, user_id: 'user-1' }];
  await expect(createCredentialRevalidation(request({ authorization: `Bearer ${fixture.state.bearer}` }), ids.site))
    .rejects.toMatchObject({ status: 403 });
});