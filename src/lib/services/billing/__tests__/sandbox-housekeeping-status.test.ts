import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { requirementStatusReferences } from '../sandbox-housekeeping-db';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));

// Exercise the actual PostgREST query serialization with an offline transport.
function mockPages(page: (params: URLSearchParams) => unknown) {
  const fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe('/rest/v1/requirement_status');
    return Response.json(page(url.searchParams));
  });
  const client = createClient('https://db.example.test', 'unused', { global: { fetch } });
  jest.mocked(supabaseAdmin.from).mockImplementation(client.from.bind(client));
  return fetch;
}

const idOf = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

it('preserves exactly the full-scan protected sets across sparse and capped pages', async () => {
  const rows = Array.from({ length: 3200 }, (_, i) => ({
    id: idOf(i),
    active_sandbox_id: i % 3 === 0 ? `vm-${i % 977}` : null,
    snapshot_id: i % 5 === 0 ? `snapshot-${i}` : i % 7 === 0 ? '' : null,
  }));
  let last: string | undefined;
  const fetch = mockPages(params => {
    expect(Object.fromEntries(params)).toEqual({
      select: 'id,active_sandbox_id,snapshot_id', order: 'id.asc', limit: '500',
      or: '(active_sandbox_id.not.is.null,snapshot_id.not.is.null)',
      ...(last ? { id: `gt.${last}` } : {}),
    });
    const page = rows.filter(r => (r.active_sandbox_id !== null || r.snapshot_id !== null) &&
      (!last || r.id > last)).slice(0, 400);
    last = page.at(-1)?.id;
    return page;
  });
  const refs = await requirementStatusReferences();
  expect(refs.activeSandboxIds).toEqual(new Set(rows.map(r => r.active_sandbox_id).filter(Boolean)));
  expect(refs.activeSnapshotIds).toEqual(new Set(rows.map(r => r.snapshot_id).filter(Boolean)));
  expect(fetch.mock.calls.length).toBeGreaterThan(3);
});

it.each([
  ['non-array page', () => null],
  ['read error', () => { throw new Error('offline failure'); }],
  ['missing projected field', () => [{ id: idOf(2), snapshot_id: 's' }]],
  ['repeated cursor', () => [{ id: idOf(1), snapshot_id: null, active_sandbox_id: 'vm' }]],
])('rejects rather than using partial protection after a %s', async (_, invalidPage) => {
  const fetch = mockPages(params => params.has('id') ? invalidPage() :
    [{ id: idOf(1), active_sandbox_id: 'vm', snapshot_id: null }]);
  await expect(requirementStatusReferences()).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('rejects an inventory that never reaches an empty page within the scan budget', async () => {
  let id = 0;
  mockPages(() => [{ id: idOf(++id), active_sandbox_id: 'vm', snapshot_id: null }]);
  await expect(requirementStatusReferences()).rejects.toThrow('pagination limit exceeded');
});
