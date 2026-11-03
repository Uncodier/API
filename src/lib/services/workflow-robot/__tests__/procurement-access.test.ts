// @ts-nocheck -- ESM mocks use dynamic imports under the project's ES5 target.
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rpc = jest.fn();
const getRequestSitePrincipal = jest.fn();
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc } }));
jest.unstable_mockModule('@/lib/security/site-access', () => ({ getRequestSitePrincipal }));
const access = await import('../procurement-access');

beforeEach(() => {
  jest.clearAllMocks();
  getRequestSitePrincipal.mockReturnValue({ internal: false, userId: 'actor-1' });
  rpc.mockResolvedValue({ data: true, error: null });
});

it('binds procurement access to the trusted principal, not body parameters', async () => {
  expect(await access.authorizeProcurementWorkflowInstanceRead(new Request('https://api.example.test'), 'instance-1', 'site-1')).toBe(true);
  expect(rpc).toHaveBeenCalledWith('procurement_workflow_instance_can_read', {
    p_site: 'site-1', p_instance: 'instance-1', p_actor: 'actor-1',
  });
});

it.each([{ data: false, error: null }, { data: null, error: { code: '42883' } }])
('fails closed when instance permission is unavailable or denied', async result => {
  rpc.mockResolvedValue(result);
  expect(await access.authorizeProcurementWorkflowInstanceRead(new Request('https://api.example.test'), 'instance-1', 'site-1')).toBe(false);
});

it('requires a canonical actor and checks current procurement permission before dispatch', async () => {
  await expect(access.assertProcurementWorkflowActorAccess('site-1', null)).rejects.toThrow('actor is required');
  expect(rpc).not.toHaveBeenCalled();
  rpc.mockResolvedValue({ data: false, error: null });
  await expect(access.assertProcurementWorkflowActorAccess('site-1', 'actor-1')).rejects.toThrow('access denied');
});

it('allows trusted internal reads without pretending they are an ordinary user', async () => {
  getRequestSitePrincipal.mockReturnValue({ internal: true, userId: null });
  expect(await access.authorizeProcurementWorkflowInstanceRead(new Request('https://api.example.test'), 'instance-1', 'site-1')).toBe(true);
  expect(rpc).not.toHaveBeenCalled();
});

it('protects direct DB reads and derived data with sticky, restrictive instance policies', () => {
  const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261104101000_procurement_workflow_confidentiality.sql'), 'utf8');
  expect(sql).toContain('AS RESTRICTIVE FOR SELECT TO authenticated');
  expect(sql).toContain("'instance_plans','instance_nodes','instance_logs','instance_context_state','instance_context_memories'");
  expect(sql).toContain("public.procurement_tender_access(p_site,'select') IS TRUE");
  expect(sql).toContain('public.site_user_has_effective_access(p_site,p_actor) IS TRUE');
  expect(sql).toContain('WHERE instance_id=p_instance');
  expect(sql).toContain('ON CONFLICT (instance_id) DO NOTHING');
  expect(sql).toContain('public.procurement_workflow_protect_instance');
  expect(sql).toContain('REVOKE ALL ON public.procurement_workflow_private_instances FROM PUBLIC, anon, authenticated, service_role');
  const materialize = readFileSync(resolve(process.cwd(), 'src/lib/services/workflow-robot/materialize.ts'), 'utf8');
  expect(materialize.indexOf("rpc('procurement_workflow_protect_instance'")).toBeLessThan(materialize.indexOf("const { data: runPlan, error: runErr }"));
});