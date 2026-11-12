import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beginCustomerInference, recordCustomerInference, rejectCustomerInference } from '../../billing/customer-inference-receipts';
import { withCustomerOperation, withCustomerCapability, getCustomerCapability,
  type ExecutionRoutingReference } from '../customer-routing';
import { supabaseAdmin } from '@/lib/database/supabase-client';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { rpc: jest.fn() } }));
const rpc = jest.mocked(supabaseAdmin.rpc);
const routing: ExecutionRoutingReference = { payer: 'customer', siteId: randomUUID(),
  connectionId: randomUUID(), policyVersion: 1, credentialVersion: 1 };
const input = { routing, capability: 'text' as const, requestedModel: 'vendor/model' };
beforeEach(() => jest.resetAllMocks());

it('durably claims before a network dispatch and rejects a replay after process loss', async () => {
  const rows = new Map<string, string>();
  rpc.mockImplementation((async (_name: string, { p_intent }: any) => {
    const previous = rows.get(p_intent.operation_key);
    if (!previous) rows.set(p_intent.operation_key, p_intent.event_id);
    return { error: null, data: { claimed: !previous, event_id: previous ?? p_intent.event_id } };
  }) as any);
  const network = jest.fn();
  const run = () => withCustomerOperation('durable-command-1', async () => {
    await beginCustomerInference(input);
    network(); // Simulate process death before response/receipt persistence.
  });
  await run();
  await expect(run()).rejects.toThrow('do not replay');
  expect(network).toHaveBeenCalledTimes(1);
  expect(rows.size).toBe(1);
});

it('denies dispatch on storage failure and mismatched claim response', async () => {
  rpc.mockResolvedValue({ data: null, error: new Error('offline') } as any);
  await expect(beginCustomerInference(input)).rejects.toThrow('do not replay');
  rpc.mockResolvedValue({ data: { claimed: true, event_id: randomUUID() }, error: null } as any);
  await expect(beginCustomerInference(input)).rejects.toThrow('do not replay');
});

it('settles confirmed rejection without fabricated zero-cost provider evidence', async () => {
  rpc.mockResolvedValue({ data: null, error: null } as any);
  const eventId = randomUUID();
  await rejectCustomerInference(eventId, routing);
  expect(rpc).toHaveBeenCalledWith('openrouter_customer_dispatch_reject', {
    p_site_id: routing.siteId, p_event_id: eventId,
  });
});

it('retains sequential operation keys and restores semantic scope', async () => {
  const keys: string[] = [];
  rpc.mockImplementation((async (_name: string, { p_intent }: any) => {
    keys.push(p_intent.operation_key);
    return { data: { claimed: true, event_id: p_intent.event_id }, error: null };
  }) as any);
  await withCustomerOperation('turn-1', async () => {
    await beginCustomerInference(input);
    await withCustomerOperation('nested', () => beginCustomerInference(input));
  });
  expect(keys).toEqual(['turn-1:0', 'turn-1:1']);
  await withCustomerCapability('summary', async () => expect(getCustomerCapability()).toBe('summary'));
  expect(getCustomerCapability()).toBeUndefined();
});

it('persists receipt with the exact intent identity and no secret/prompt fields', async () => {
  rpc.mockResolvedValue({ error: null } as any);
  const eventId = randomUUID();
  await recordCustomerInference({ ...input, eventId, usage: { cost: 0, prompt: 'must not persist' } });
  expect(rpc.mock.calls[0][1]).toEqual({ p_receipt: expect.objectContaining({ event_id: eventId, state: 'completed' }) });
  expect(JSON.stringify(rpc.mock.calls)).not.toContain('must not persist');
});

it('forward SQL locks ownership, uniquely claims, atomically settles and never expires claims', () => {
  const sql = readFileSync(resolve(process.cwd(), '../market-fit/supabase/migrations/20261112020000_openrouter_runtime_dispatch.sql'), 'utf8');
  expect(sql).toContain('UNIQUE (site_id, operation_key)');
  expect(sql).toContain('FOR SHARE OF c');
  expect(sql).toContain('ON CONFLICT DO NOTHING');
  expect(sql).toContain('AFTER INSERT ON public.openrouter_customer_receipts');
  expect(sql).toContain('Receipt requires dispatch intent');
  expect(sql).toContain('FROM PUBLIC, anon, authenticated');
  expect(sql).toContain('openrouter_customer_dispatch_reconciliations');
  expect(sql).not.toMatch(/SET state = 'dispatching'/);
});