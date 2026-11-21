import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadExternalDataset } from '../supabase-analytics-registry';
import { connectorFixture } from './composio-fixtures';

jest.mock('server-only', () => ({}));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: jest.fn() } }));
const rpc = supabaseAdmin.rpc as jest.Mock;
const siteId = randomUUID(), projectRef = 'a'.repeat(20);
const connector = { ...connectorFixture(), id: randomUUID(), site_id: siteId, supabase_project_ref: projectRef,
  toolkit_slug: 'supabase', revocation_dispatched: false };
const source = { name: 'bookings', schema: 'makinari_facts_studio', table: 'monthly', siteColumn: 'workspace', columns: [
  { name: 'total', column: 'gross', type: 'numeric' }, { name: 'currency', column: 'ccy', type: 'text', values: ['USD','MXN'] } ],
  money: { currency: 'currency', measures: ['total'] } };
const mapping = { siteId, projectRef, sources: [source] };
const missing = { siteId, projectRef, missing: true };
const unavailable = { code: 'CATALOG_AUTHORIZATION_UNAVAILABLE', status: 503 };
const env = 'CONNECTOR_ANALYTICS_EXTERNAL_DATASETS';
const legacy = process.env[env];
const call = () => loadExternalDataset(connector);
const reply = (data: unknown, error: unknown = null) => {
  const abortSignal = jest.fn().mockResolvedValue({ data, error });
  rpc.mockReturnValueOnce({ abortSignal });
  return abortSignal;
};
beforeEach(() => { rpc.mockReset(); });
afterEach(() => { if (legacy === undefined) delete process.env[env]; else process.env[env] = legacy; });

test('looks up exactly the authorized site, project, connector and revision; compiles only reviewed fields and the bound site', async () => {
  const abort = reply(mapping);
  const result = await call();
  expect(rpc.mock.calls).toEqual([['connector_external_analytics_dataset', {
    p_connector_id: connector.id, p_connector_revision: connector.revision, p_site_id: siteId, p_project_ref: projectRef,
  }]]);
  expect(abort).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(result?.parameters).toEqual([siteId]);
  expect(Object.keys(result!.sources)).toEqual(['bookings']);
  expect(result!.sources.bookings).toMatchObject({ columns: { site_id: 'uuid', total: 'numeric', currency: 'text' },
    money: source.money, sql: expect.stringContaining('WHERE f."workspace" = $1::pg_catalog.uuid') });
  expect(result!.sources.bookings.guardSql).toContain('pg_catalog.has_column_privilege');
});

test('reloads changes and verified absence each time; old environment configuration cannot revive a deleted mapping', async () => {
  process.env[env] = JSON.stringify([mapping]);
  reply(mapping); const first = await call();
  reply({ ...mapping, sources: [{ ...source, table: 'weekly' }] });
  const next = await call();
  expect(next!.sources.bookings.sql).not.toBe(first!.sources.bookings.sql);
  reply(missing); await expect(call()).resolves.toBeNull();
  expect(rpc).toHaveBeenCalledTimes(3);
});

test('rejects a malformed, unverified, disabled or revoking connector before privileged lookup', async () => {
  for (const override of [{ site_id: siteId+'\n' }, { id: 'invalid' }, { revision: 0 }, { revision: NaN }, { verified_at: null },
    { supabase_project_ref: projectRef+'\n' }, { toolkit_slug: 'gmail' }, { enabled: false }, { provider_status: 'REVOKED' },
    { revocation_pending: true }, { revocation_dispatched: true }, { revocation_dispatched: undefined }]) {
    await expect(loadExternalDataset({ ...connector, ...override })).rejects.toMatchObject({ code: 'CONNECTOR_PROJECT_UNBOUND' });
  }
  expect(rpc).not.toHaveBeenCalled();
});

test('a response for another site or project, ambiguous absence and malformed source definitions never enable direct analytics', async () => {
  process.env[env] = JSON.stringify([mapping]);
  for (const bad of [null, undefined, [], [mapping], {}, 'null', { ...mapping, siteId: randomUUID() },
    { ...mapping, projectRef: 'b'.repeat(20) }, { ...missing, siteId: randomUUID() }, { ...missing, projectRef: 'b'.repeat(20) },
    { ...mapping, missing: true }, { ...mapping, sources: [] }, { ...mapping, sources: [source, source] },
    { ...mapping, sources: [source, { ...source, name: 'paid_sales' }] },
    { ...mapping, sources: [{ ...source, schema: 'connector_result_private' }] },
    { ...mapping, sources: [{ ...source, sql: 'select 1' }] }, { ...mapping, sources: [{ ...source, columns: [
      { name: 'description', column: 'description', type: 'text' }] }] }]) {
    reply(bad); await expect(call()).rejects.toMatchObject(unavailable);
  }
});

test('timeouts, SQL errors, missing RPC and empty transport responses are not missing mappings, and diagnostics remain private', async () => {
  const diagnostic = randomUUID();
  for (const code of ['42883', '42501', '57014','PGRST202']) {
    reply(missing, { code, message: diagnostic });
    const failure = await call().catch(e => e);
    expect(failure).toMatchObject(unavailable); expect(String(failure)).not.toContain(diagnostic);
  }
  rpc.mockReturnValueOnce({ abortSignal: () => Promise.reject(new Error(diagnostic)) });
  await expect(call()).rejects.toMatchObject(unavailable);
  rpc.mockImplementationOnce(() => { throw new Error(diagnostic); });
  await expect(call()).rejects.toMatchObject(unavailable);
  rpc.mockReturnValueOnce({ abortSignal: () => Promise.resolve({ data: null, error: null, status: 204 }) });
  await expect(call()).rejects.toMatchObject(unavailable);
  reply(null, { code: 'P0C02', message: diagnostic });
  await expect(call()).rejects.toMatchObject({ code: 'ACCESS_CHANGED', status: 403 });
});
