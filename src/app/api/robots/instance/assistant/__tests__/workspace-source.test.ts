import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { resolveAssistantWorkspaceSource } from '../workspace-source';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@vercel/sandbox', () => ({ Sandbox: {} }));
const scope = { instanceId: randomUUID(), siteId: randomUUID(), userId: randomUUID() };
const req = randomUUID(), session = randomUUID();
let tables: Record<string, any>;
let queries: Array<{ table: string; filters: Array<[string, unknown]> }>;
beforeEach(() => {
  jest.clearAllMocks(); queries = [];
  tables = { remote_instances: { id: scope.instanceId, site_id: scope.siteId, is_archived: false },
    requirements: [], requirement_status: [], harness_sessions: [], instance_plans: [], sandbox_billing_resources: [] };
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const filters: Array<[string, unknown]> = [];
    queries.push({ table, filters });
    const q: any = {};
    let offset = 0, end = 500;
    for (const method of ['select', 'limit', 'not']) q[method] = () => q;
    q.order = (column: string) => {
      if (table === 'harness_sessions' && !['snapshot->>updatedAt', 'id'].includes(column)) {
        throw new Error('harness_sessions timestamps live inside snapshot, not table columns');
      }
      return q;
    };
    q.eq = (key: string, value: unknown) => { filters.push([key, value]); return q; };
    q.range = (start: number, last: number) => { offset = start; end = last + 1; return q; };
    const response = () => {
      const value = tables[table];
      if (value instanceof Error) return { data: null, error: value };
      const data = table === 'requirement_status' ? value.slice(offset, end) : value;
      return { data, error: null };
    };
    q.maybeSingle = async () => {
      const r = response(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data };
    };
    q.then = (resolve: any, reject: any) => Promise.resolve(response()).then(resolve, reject);
    return q;
  });
});

it('allows a new standalone workspace only after scoped binding reads', async () => {
  expect(await resolveAssistantWorkspaceSource(scope)).toEqual({ kind: 'instance' });
  expect(queries.every(q => q.filters.some(([key, value]) => key === 'site_id' && value === scope.siteId))).toBe(true);
});

it('preserves the saved workspace of an ordinary workflow when there is no requirement', async () => {
  const plan = randomUUID();
  tables.instance_plans = [{ id: plan, active_sandbox_id: `wf-${plan}` }];
  tables.sandbox_billing_resources = [{ site_id: scope.siteId, owner_kind: 'workflow', owner_id: plan }];
  expect(await resolveAssistantWorkspaceSource(scope)).toEqual({ kind: 'workflow', planId: plan, sandboxName: `wf-${plan}` });
});

it.each(['paused', 'completed', 'blocked'])('retains %s requirement files instead of opening an empty workspace', async status => {
  tables.requirements = [{ id: req, site_id: scope.siteId, status }];
  tables.requirement_status = [{ requirement_id: req, active_sandbox_id: null }];
  tables.harness_sessions = [{ id: session, site_id: scope.siteId, workspace: { id: `h-${session}`, provider: 'vercel', root: '/vercel/sandbox' } }];
  expect(await resolveAssistantWorkspaceSource(scope)).toEqual({ kind: 'requirement', requirementId: req, sandboxName: `h-${session}` });
});

it('paginates history and preserves a legacy workspace rather than using only the last status', async () => {
  tables.requirements = [{ id: req, site_id: scope.siteId }];
  tables.requirement_status = Array.from({ length: 650 }, (_, i) => ({ requirement_id: req, active_sandbox_id: i === 600 ? 'legacy-saved' : null }));
  tables.sandbox_billing_resources = [{ site_id: scope.siteId, owner_kind: 'requirement', owner_id: req }];
  expect(await resolveAssistantWorkspaceSource(scope)).toMatchObject({ sandboxName: 'legacy-saved' });
  expect(queries.filter(q => q.table === 'requirement_status')).toHaveLength(2);
});

it('does not trust an editable historical sandbox reference without a matching service-owned owner', async () => {
  tables.requirements = [{ id: req, site_id: scope.siteId }];
  tables.requirement_status = [{ requirement_id: req, active_sandbox_id: 'foreign-resource' }];
  tables.sandbox_billing_resources = [{ site_id: randomUUID(), owner_kind: 'requirement', owner_id: req }];
  await expect(resolveAssistantWorkspaceSource(scope)).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_MISMATCH' });
});

it('does not select a latest requirement across conflicting history', async () => {
  tables.requirements = [{ id: req, site_id: scope.siteId }];
  tables.requirement_status = [{ requirement_id: randomUUID(), active_sandbox_id: 'foreign' }];
  await expect(resolveAssistantWorkspaceSource(scope)).rejects.toMatchObject({ code: 'WORKSPACE_BINDING_AMBIGUOUS' });
});

it.each(['requirements', 'requirement_status', 'remote_instances'])('does not turn %s outage into a new empty workspace', async table => {
  tables[table] = new Error('offline');
  await expect(resolveAssistantWorkspaceSource(scope)).rejects.toMatchObject({ code: 'WORKSPACE_LOOKUP_UNAVAILABLE' });
});

it('rejects an archived instance', async () => {
  tables.remote_instances.is_archived = true;
  await expect(resolveAssistantWorkspaceSource(scope)).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_MISMATCH' });
});

it('reports unavailable work without asserting no advances exist', async () => {
  tables.requirements = [{ id: req, site_id: scope.siteId }];
  await expect(resolveAssistantWorkspaceSource(scope)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_CREATED' });
});

it('rejects a workspace reference that belongs to a different session', async () => {
  tables.requirements = [{ id: req, site_id: scope.siteId }];
  tables.harness_sessions = [{ id: session, site_id: scope.siteId,
    workspace: { id: `h-${randomUUID()}`, provider: 'vercel', root: '/vercel/sandbox' } }];
  await expect(resolveAssistantWorkspaceSource(scope)).rejects.toMatchObject({ code: 'WORKSPACE_SCOPE_MISMATCH' });
});