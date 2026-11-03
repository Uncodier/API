// @ts-nocheck -- ESM Jest mocks are dynamically imported under the project's ES5 TS target.
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DB_EVENT_TABLES } from '../types';

const from = jest.fn();
const materializeRunFromGraph = jest.fn();
const runWorkflowPlan = jest.fn();
const assertProcurementWorkflowActorAccess = jest.fn();
jest.unstable_mockModule('../procurement-access', () => ({
  assertProcurementWorkflowActorAccess,
  isProcurementWorkflowTable: table => tables.includes(table),
}));
jest.unstable_mockModule('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from } }));
jest.unstable_mockModule('../materialize', () => ({ materializeRunFromGraph }));
jest.unstable_mockModule('../run-plan', () => ({ runWorkflowPlan }));
const { dispatchWorkflowEvent } = await import('../dispatch');

const tables = [
  'suppliers', 'supplier_contacts', 'catalog_item_suppliers',
  'procurement_requests', 'procurement_tenders', 'procurement_tender_publications',
  'procurement_tender_participants', 'procurement_event_approvals',
  'procurement_awards', 'purchase_orders', 'procurement_receipts',
  'procurement_replenishment_rules', 'procurement_replenishment_cases',
];
const sql = readFileSync(resolve(process.cwd(),
  'supabase/migrations/20261104100000_procurement_workflow_database_webhooks.sql'), 'utf8');

beforeEach(() => {
  jest.clearAllMocks();
  materializeRunFromGraph.mockResolvedValue({ run_plan_id: 'run-1', steps: [{ id: 'step-1' }] });
  runWorkflowPlan.mockResolvedValue(undefined);
  assertProcurementWorkflowActorAccess.mockResolvedValue(undefined);
});

it('registers exactly the supported procurement tables using the shared authenticated webhook', () => {
  const migrationTables = [...sql.matchAll(/^    '([a-z_]+)'/gm)].map(match => match[1]);
  expect(migrationTables).toEqual(tables);
  expect(DB_EVENT_TABLES).toEqual(expect.arrayContaining(tables));
  expect(sql).toContain("to_regprocedure('public.dispatch_workflow_database_webhook()')");
  expect(sql).toContain("attname = 'site_id' AND NOT attisdropped");
  expect(sql).toContain("atttypid = 'uuid'::regtype");
  expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON public.%I');
  expect(sql).toContain('FOR EACH ROW EXECUTE FUNCTION public.dispatch_workflow_database_webhook()');
  expect(sql.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
});

it.each(tables.flatMap(table => ['insert', 'update', 'delete'].map(op => [table, op])))
('dispatches %s %s to enabled workflows in the event workspace', async (table, op) => {
  const query = {
    select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    then: resolve => Promise.resolve({ data: [{
      id: 'trigger-1', instance_id: 'instance-1', template_plan_id: 'template-1',
      config: { db_events: [{ table, op: [op] }], filter: { status: 'approved' } },
    }], error: null }).then(resolve),
  };
  from.mockImplementation(tableName => tableName === 'remote_instances' ? {
    select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { user_id: 'canonical-owner' }, error: null }),
  } : query);
  const row = { id: 'record-1', site_id: 'site-1', status: 'approved' };
  expect(await dispatchWorkflowEvent({ table, op, site_id: 'site-1', row }))
    .toEqual({ started: 1, skipped: 0 });
  expect(query.eq).toHaveBeenCalledWith('site_id', 'site-1');
  expect(query.eq).toHaveBeenCalledWith('kind', 'db_event');
  expect(query.eq).toHaveBeenCalledWith('enabled', true);
  expect(materializeRunFromGraph).toHaveBeenCalledWith(expect.objectContaining({
    instance_id: 'instance-1', trigger_id: 'trigger-1',
    trigger_payload: expect.objectContaining({ table, op, row }),
  }));
  expect(runWorkflowPlan).toHaveBeenCalledWith('run-1');
  expect(assertProcurementWorkflowActorAccess).toHaveBeenCalledWith('site-1', 'canonical-owner');
});

it('does not materialize or execute events after the workflow actor loses purchasing access', async () => {
  const query = {
    select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    then: resolve => Promise.resolve({ data: [{ id: 'trigger-1', instance_id: 'instance-1',
      config: { table: 'procurement_requests' } }], error: null }).then(resolve),
  };
  from.mockImplementation(table => table === 'remote_instances' ? {
    select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { user_id: 'revoked-owner' }, error: null }),
  } : query);
  assertProcurementWorkflowActorAccess.mockRejectedValue(new Error('Procurement workflow access denied'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await dispatchWorkflowEvent({ table: 'procurement_requests', op: 'update', site_id: 'site-1', row: { id: 'row-1' } }))
      .toEqual({ started: 0, skipped: 1 });
    expect(materializeRunFromGraph).not.toHaveBeenCalled();
    expect(runWorkflowPlan).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

it.each(['procurement_credentials', 'procurement_submission_drafts', 'procurement_replenishment_queue',
  'procurement_request_items', 'procurement_event_decisions'])
('does not enable sensitive or internal table %s', async table => {
  expect(DB_EVENT_TABLES).not.toContain(table);
  expect(await dispatchWorkflowEvent({ table, op: 'insert', site_id: 'site-1', row: { id: 'row-1' } }))
    .toEqual({ started: 0, skipped: 0 });
  expect(from).not.toHaveBeenCalled();
});