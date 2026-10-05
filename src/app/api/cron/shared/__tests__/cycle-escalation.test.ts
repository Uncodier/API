import { randomBytes } from 'node:crypto';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { ensureCycleTechnicalEscalation } from '@/lib/services/harness-diagnostics/cycle-escalation';
import type { HarnessDiagnosticContext } from '@/lib/services/harness-diagnostics/context';
import { deliverHarnessSupportTicket } from '@/lib/services/harness-diagnostics/support';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/services/harness-diagnostics/support', () => ({ deliverHarnessSupportTicket: jest.fn() }));

const SITE = '00000000-0000-4000-8000-000000000001';
const INSTANCE = '00000000-0000-4000-8000-000000000002';
const REQUIREMENT = '00000000-0000-4000-8000-000000000003';
const TICKET = '00000000-0000-4000-8000-000000000004';
const OTHER = '00000000-0000-4000-8000-000000000005';
const TIME = '2026-10-01T00:00:00.123456+00:00';
const LATER = '2026-10-01T00:01:00.000Z';
const UNAVAILABLE = { state: 'unavailable', email_sent: false };
const EXHAUSTED = 'Automatic execution stopped at its bounded recovery limit; inspect canonical action receipts before attributing individual repairs.';
const context = (): HarnessDiagnosticContext => ({ siteId: SITE, instanceId: INSTANCE,
  requirementId: REQUIREMENT, runtime: 'cron', toolNames: [] });

function requirement() {
  return { id: REQUIREMENT, site_id: SITE, status: 'blocked', updated_at: TIME, backlog_revision: 2,
    metadata: { runner_instance_id: INSTANCE, requirement_execution_generation: 7 },
    instructions: 'PRIVATE SPECIFICATION: SELECT customer_email FROM clients;',
    backlog: { items: [{ id: 'base', status: 'needs_review', attempts: 3, acceptance: ['Works'], budget: 1 }] } };
}

function receipt(args: Record<string, any>, overrides: Record<string, any> = {}) {
  return { id: TICKET, site_id: args.p_site_id, requirement_id: args.p_requirement_id, instance_id: args.p_instance_id,
    request_id: args.p_request_id, decision: args.decision || 'escalate_support', item_id: null,
    reason: args.p_reason, payload: args.p_payload, status: 'recorded',
    contract_snapshot: { backlog_revision: args.p_expected_backlog_revision,
      requirement_updated_at: args.p_expected_updated_at }, ...overrides };
}

type Lookup = { data: any; error?: any; reject?: unknown };
function fixture() {
  const h = {
    requirement: requirement() as Record<string, any>,
    instance: { id: INSTANCE, site_id: SITE, is_archived: false },
    plans: [] as any[], receipts: [] as any[], queries: [] as any[],
    recoveryReads: [] as Lookup[],
    lookups: [] as Lookup[], requirementReads: [] as Lookup[],
    forbiddenWrites: jest.fn(() => { throw new Error('Direct writes forbidden.'); }),
  };
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const filters: Array<[string, unknown]> = [];
    const q: any = { table, filters };
    for (const name of ['select', 'contains', 'order', 'limit', 'in', 'or', 'maybeSingle']) q[name] = jest.fn(() => q);
    for (const name of ['eq', 'is']) q[name] = jest.fn((key: string, value: unknown) => { filters.push([key, value]); return q; });
    for (const name of ['update', 'insert', 'upsert', 'delete']) q[name] = h.forbiddenWrites;
    q.then = (resolve: any, reject: any) => {
      let result: Lookup;
      if (table === 'requirement_harness_decisions') {
        const queued = h.lookups.shift();
        const rows = h.receipts.filter(row => filters.every(([key, value]) => row[key] === value));
        result = queued || { data: q.maybeSingle.mock.calls.length ? rows[0] || null : rows };
      } else if (table === 'requirements') {
        result = h.requirementReads.shift() || { data: h.requirement };
      } else if (table === 'remote_instances') {
        result = { data: h.instance };
      } else if (table === 'instance_plans') {
        result = { data: h.plans };
      } else if (['requirement_migration_lifecycle', 'requirement_migration_diagnostics', 'instance_plan_step_infrastructure_events'].includes(table)) {
        result = h.recoveryReads.shift() || { data: [] };
      } else {
        throw new Error(`Unexpected table ${table}`);
      }
      return (result.reject ? Promise.reject(result.reject) : Promise.resolve({ error: null, ...result })).then(resolve, reject);
    }
    h.queries.push(q);
    return q;
  });
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(async (name: string, args: Record<string, any>) => {
    if (name !== 'record_harness_diagnostic_decision') throw new Error('Unexpected RPC');
    const ticket = receipt(args);
    h.receipts.push(ticket);
    return { data: { decision: ticket }, error: null };
  });
  (deliverHarnessSupportTicket as jest.Mock).mockResolvedValue({ state: 'unconfigured', email_sent: false });
  return h;
}

const rpcArgs = (call = 0) => (supabaseAdmin.rpc as jest.Mock).mock.calls[call][1];
beforeEach(() => jest.resetAllMocks());

it('records only a support decision via the guarded RPC, never repairs or customer approval', async () => {
  const h = fixture();
  h.requirement.backlog.items[0].review_quarantine = { active: true, kind: 'verification_exhausted' };
  const original = JSON.stringify(h.requirement);
  const assertCurrent = jest.fn(async () => undefined);
  expect(await ensureCycleTechnicalEscalation(context(), { reason: 'Product verification/repair exhausted', assertCurrent }))
    .toEqual({ state: 'recorded', ticket_id: TICKET, email_sent: false, delivery_state: 'unconfigured' });
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
  expect(rpcArgs()).toEqual({
    p_site_id: SITE, p_requirement_id: REQUIREMENT, p_instance_id: INSTANCE,
    p_expected_backlog_revision: 2, p_expected_updated_at: TIME,
    p_request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    p_decision: 'escalate_support', p_item_id: null, p_reason: 'Product verification/repair exhausted',
    p_payload: { circuit_breaker: expect.objectContaining({ version: 1, no_runnable_work: true, no_pending_recovery: true,
        exhaustion: [expect.objectContaining({ kind: 'product_attempts', used: 3, limit: 3 })] }),
      evidence_log_ids: [], verification: expect.any(String), impact: expect.stringContaining('No customer product approval'),
      requested_action: 'inspect gate/test fixtures and request/response contract; repair under existing guards; reconcile exhausted execution before fresh validation',
      attempted_alternatives: [EXHAUSTED] },
  });
  expect(assertCurrent).toHaveBeenCalledTimes(3);
  expect(assertCurrent.mock.invocationCallOrder[1]).toBeLessThan((supabaseAdmin.rpc as jest.Mock).mock.invocationCallOrder[0]);
  expect(assertCurrent.mock.invocationCallOrder[2]).toBeLessThan((deliverHarnessSupportTicket as jest.Mock).mock.invocationCallOrder[0]);
  expect(h.forbiddenWrites).not.toHaveBeenCalled();
  expect(new Set(h.queries.map(q => q.table))).toEqual(new Set(['requirements', 'remote_instances', 'instance_plans', 'requirement_harness_decisions',
    'requirement_migration_lifecycle', 'requirement_migration_diagnostics']));
  expect(JSON.stringify(h.requirement)).toBe(original);
  expect(JSON.stringify(rpcArgs())).not.toMatch(/PRIVATE SPECIFICATION|SELECT customer_email|budget|implementation_instructions|acceptance_mapping/);
});

it.each([undefined, null, '', '  ', 'Host routed unresolved verification to internal_review',
  'Internal review without exhaustion', 'Recovery not exhausted; unresolved contract needs review',
  'Last error excerpt claims repair exhausted', 'Product verification/repair exhausted'])
('does not invent bounded exhaustion or executed repairs for reason %j', async reason => {
  const h = fixture();
  h.requirement.backlog.items[0].attempts = 0;
  expect(await ensureCycleTechnicalEscalation(context(), { reason })).toEqual({ state: 'not_eligible', reason: 'no_exhaustion', email_sent: false });
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it.each([{ active: false, kind: 'verification_exhausted' }, { active: true, kind: 'capability_gap' },
  { active: true, kind: 'manual' }, { active: 'true', kind: 'verification_exhausted' }])
('does not infer exhaustion from a released or unrelated quarantine %j', async quarantine => {
  const h = fixture();
  h.requirement.backlog.items[0].attempts = 0;
  h.requirement.backlog.items[0].review_quarantine = quarantine;
  await ensureCycleTechnicalEscalation(context(), { reason: 'Internal review' });
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
});

it('looks up exact caller-bound request first and replays the original ticket after reporting changes timestamps', async () => {
  const h = fixture();
  await ensureCycleTechnicalEscalation(context(), { reason: 'Product repair exhausted' });
  const original = structuredClone(h.receipts[0]);
  h.requirement = { ...h.requirement, updated_at: LATER };
  (deliverHarnessSupportTicket as jest.Mock).mockResolvedValue({ state: 'sent', email_sent: true });
  expect(await ensureCycleTechnicalEscalation({ ...context(), runtime: 'another-host-runtime', toolNames: ['irrelevant'] },
    { reason: 'Different reason must not replace original payload' }))
    .toEqual({ state: 'recorded', ticket_id: TICKET, email_sent: true, delivery_state: 'sent' });
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
  expect(h.receipts).toEqual([original]);
  expect(deliverHarnessSupportTicket).toHaveBeenLastCalledWith(original, expect.objectContaining({ instanceId: INSTANCE }));
  const lookups = h.queries.filter(q => q.table === 'requirement_harness_decisions');
  expect(lookups).toHaveLength(2);
  for (const query of lookups) {
    expect(query.filters).toEqual([['request_id', original.request_id], ['requirement_id', REQUIREMENT], ['site_id', SITE], ['instance_id', INSTANCE]]);
  }
});

it('keeps the same UUID after an uncertain commit, including timestamp changes, without falsely claiming storage', async () => {
  const h = fixture();
  (supabaseAdmin.rpc as jest.Mock).mockImplementationOnce(async (_name, args) => {
    h.receipts.push(receipt(args));
    throw new Error('Commit response lost: private storage detail');
  });
  expect(await ensureCycleTechnicalEscalation(context(), { reason: 'Exhausted recovery' })).toEqual(UNAVAILABLE);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
  h.requirement.updated_at = LATER;
  expect(await ensureCycleTechnicalEscalation(context(), { reason: 'New reason' })).toMatchObject({ state: 'recorded', ticket_id: TICKET });
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
  expect(deliverHarnessSupportTicket).toHaveBeenCalledWith(h.receipts[0], context());
});

it('derives a stable UUID after a failed write independently of timestamps, revision and host prose', async () => {
  const h = fixture();
  (supabaseAdmin.rpc as jest.Mock).mockResolvedValueOnce({ data: null, error: { message: 'storage_unavailable' } });
  await ensureCycleTechnicalEscalation(context(), { reason: 'First reason' });
  h.requirement = { ...h.requirement, updated_at: LATER, backlog_revision: 9 };
  await ensureCycleTechnicalEscalation(context(), { reason: 'Second reason' });
  expect(rpcArgs(1).p_request_id).toBe(rpcArgs().p_request_id);
  expect(rpcArgs(1)).toMatchObject({ p_expected_updated_at: LATER, p_expected_backlog_revision: 9 });
});

it.each(['site', 'requirement', 'caller', 'generation'])('binds the request UUID to %s', async key => {
  const h = fixture();
  await ensureCycleTechnicalEscalation(context(), {});
  const ctx = context();
  if (key === 'site') { ctx.siteId = OTHER; h.requirement.site_id = OTHER; h.instance.site_id = OTHER; }
  if (key === 'requirement') { ctx.requirementId = OTHER; h.requirement.id = OTHER; }
  if (key === 'caller') { ctx.instanceId = OTHER; h.instance.id = OTHER; h.requirement.metadata.runner_instance_id = OTHER; }
  if (key === 'generation') h.requirement.metadata.requirement_execution_generation++;
  await ensureCycleTechnicalEscalation(ctx, {});
  expect(rpcArgs(1).p_request_id).not.toBe(rpcArgs().p_request_id);
});

it.each(['in-progress', 'pending', 'backlog', 'on-review', 'done', null])('never escalates non-blocked state %j', async status => {
  const h = fixture();
  h.requirement.status = status;
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it('fails closed on unassociated callers, including an existing receipt', async () => {
  const h = fixture();
  await ensureCycleTechnicalEscalation(context(), {});
  h.requirement.metadata.runner_instance_id = OTHER;
  (supabaseAdmin.rpc as jest.Mock).mockClear();
  (deliverHarnessSupportTicket as jest.Mock).mockClear();
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it('honors the RPC support authority for an associated historical plan caller', async () => {
  const h = fixture();
  h.requirement.metadata.runner_instance_id = OTHER;
  h.plans.push({ id: OTHER, instance_id: INSTANCE, status: 'completed', steps: [], updated_at: TIME });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toMatchObject({ state: 'recorded' });
  expect(rpcArgs().p_instance_id).toBe(INSTANCE);
});

it.each([-1, 1.5, 'bad-generation', '', true, {}, 1e10])('rejects malformed generation %j', async generation => {
  const h = fixture();
  h.requirement.metadata.requirement_execution_generation = generation;
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
});

it('normalizes legacy generation zero and numeric strings to the same identity', async () => {
  const h = fixture();
  delete h.requirement.metadata.requirement_execution_generation;
  await ensureCycleTechnicalEscalation(context(), {});
  h.requirement.metadata.requirement_execution_generation = '0';
  await ensureCycleTechnicalEscalation(context(), {});
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
});

it.each([
  { message: 'harness_decision_stale_state', code: 'PT409' },
  { message: 'harness_decision_stale_state', code: '40001' }, // Legacy deployments still fail closed.
  { message: 'harness_decision_scope_denied', code: '42501' },
  { message: 'storage_unavailable', code: '08006' },
])('never claims a ticket, sends email or retries the RPC on $message ($code)', async error => {
  fixture();
  (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({ data: null, error });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it.each(['sent', 'failed', 'unconfigured', 'sending', 'unknown', 'unavailable'])
('reports delivery state %s without conflating email and persistence', async state => {
  fixture();
  (deliverHarnessSupportTicket as jest.Mock).mockResolvedValue({ state, email_sent: state === 'sent' });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual({ state: 'recorded', ticket_id: TICKET,
    email_sent: state === 'sent', delivery_state: state });
});

it('keeps a stored ticket when delivery throws and does not expose provider errors', async () => {
  fixture();
  (deliverHarnessSupportTicket as jest.Mock).mockRejectedValue(new Error('Provider: Bearer private-token SELECT * FROM clients'));
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual({ state: 'recorded', ticket_id: TICKET,
    email_sent: false, delivery_state: 'unavailable' });
});

it.each([1, 2, 3])('propagates the original ownership error at guard %d', async guard => {
  fixture();
  const ownershipError = { name: 'CronExecutionOwnershipError', reason: 'stale_generation' };
  let calls = 0;
  const assertCurrent = jest.fn(async () => { if (++calls === guard) throw ownershipError; });
  await expect(ensureCycleTechnicalEscalation(context(), { assertCurrent })).rejects.toBe(ownershipError);
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(guard === 3 ? 1 : 0);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it('revalidates ownership before delivering an exact replay', async () => {
  fixture();
  await ensureCycleTechnicalEscalation(context(), {});
  (deliverHarnessSupportTicket as jest.Mock).mockClear();
  const error = new Error('Ownership changed');
  const assertCurrent = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
  await expect(ensureCycleTechnicalEscalation(context(), { assertCurrent })).rejects.toBe(error);
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it.each(['generation', 'status', 'authority'])('rechecks %s before delivery even without an ownership closure', async changed => {
  const h = fixture();
  const next = structuredClone(h.requirement);
  if (changed === 'generation') next.metadata.requirement_execution_generation++;
  if (changed === 'status') next.status = 'in-progress';
  if (changed === 'authority') next.metadata.runner_instance_id = OTHER;
  h.requirementReads.push({ data: h.requirement }, { data: next });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it.each(['error', 'throw'])('returns unavailable when initial ticket lookup fails with %s', async mode => {
  const h = fixture();
  h.lookups.push(mode === 'error' ? { data: null, error: { message: 'storage failed' } }
    : { data: null, reject: new Error('storage failed') });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it('returns unavailable when scope storage throws or the instance is archived', async () => {
  const h = fixture();
  h.requirementReads.push({ data: null, reject: new Error('private database error') });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  h.instance.is_archived = true;
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it.each(['id', 'site_id', 'requirement_id', 'instance_id', 'request_id', 'decision', 'item_id', 'status'])
('does not trust an invalid RPC receipt %s', async field => {
  fixture();
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(async (_name, args) => ({
    data: { decision: receipt(args, { [field]: field === 'id' ? 'invalid' : OTHER }) }, error: null,
  }));
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it('does not trust a mismatched exact lookup or bypass it with another write', async () => {
  const h = fixture();
  await ensureCycleTechnicalEscalation(context(), {});
  h.lookups.push({ data: { ...h.receipts[0], instance_id: OTHER } });
  (deliverHarnessSupportTicket as jest.Mock).mockClear();
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it.each(['harness_decision_request_conflict', 'harness_support_ticket_exists'])
('recovers a concurrent exact receipt unchanged after %s', async message => {
  const h = fixture();
  (supabaseAdmin.rpc as jest.Mock).mockImplementationOnce(async (_name, args) => {
    h.receipts.push(receipt(args, { reason: 'Original concurrent reason',
      payload: { ...args.p_payload, verification: 'Original verification must survive' } }));
    return { data: null, error: { message } };
  });
  expect(await ensureCycleTechnicalEscalation(context(), { reason: 'Later concurrent reason' })).toMatchObject({ state: 'recorded' });
  expect(deliverHarnessSupportTicket).toHaveBeenCalledWith(h.receipts[0], context());
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
});

it('adopts only the same caller and snapshot after the RPC snapshot dedup guard', async () => {
  const h = fixture();
  (supabaseAdmin.rpc as jest.Mock).mockImplementationOnce(async (_name, args) => {
    h.receipts.push(receipt(args, { request_id: OTHER, reason: 'Original manual technical ticket',
      contract_snapshot: { backlog_revision: 2, requirement_updated_at: '2026-10-01T01:00:00.123456+01:00' } }));
    return { data: null, error: { message: 'harness_support_ticket_exists' } };
  });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toMatchObject({ state: 'recorded', ticket_id: TICKET });
  expect(deliverHarnessSupportTicket).toHaveBeenCalledWith(h.receipts[0], context());
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
  const query = h.queries.filter(q => q.table === 'requirement_harness_decisions').at(-1);
  expect(query.filters).toEqual([['requirement_id', REQUIREMENT], ['site_id', SITE], ['instance_id', INSTANCE], ['decision', 'escalate_support'], ['item_id', null]]);
  expect(query.contains).toHaveBeenCalledWith('contract_snapshot', { backlog_revision: 2 });
});

it.each(['site_id', 'requirement_id', 'instance_id', 'item_id', 'revision', 'timestamp', 'microseconds'])
('never adopts an unrelated snapshot receipt (%s)', async field => {
  const h = fixture();
  (supabaseAdmin.rpc as jest.Mock).mockImplementationOnce(async (_name, args) => {
    const ticket = receipt(args, { request_id: OTHER });
    if (field === 'revision') ticket.contract_snapshot.backlog_revision++;
    else if (field === 'timestamp') ticket.contract_snapshot.requirement_updated_at = LATER;
    else if (field === 'microseconds') ticket.contract_snapshot.requirement_updated_at = '2026-10-01T00:00:00.123457Z';
    else (ticket as any)[field] = OTHER;
    // Return the foreign row even if filters were correct, testing receipt validation too.
    h.lookups.push({ data: null }, { data: [ticket] });
    return { data: null, error: { message: 'harness_support_ticket_exists' } };
  });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
});

it.each(['none', 'ambiguous', 'error', 'throw'])('fails closed when snapshot fallback is %s', async mode => {
  const h = fixture();
  (supabaseAdmin.rpc as jest.Mock).mockImplementationOnce(async (_name, args) => {
    const ticket = receipt(args, { request_id: OTHER });
    h.lookups.push({ data: null }, mode === 'error' ? { data: null, error: { message: 'unavailable' } }
      : mode === 'throw' ? { data: null, reject: new Error('unavailable') }
        : { data: mode === 'ambiguous' ? [ticket, { ...ticket, id: OTHER }] : [] });
    return { data: null, error: { message: 'harness_support_ticket_exists' } };
  });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
});

it('sanitizes and bounds host reasons before persistence and never exposes raw diagnostics in its result', async () => {
  fixture();
  // Synthetic, offline values: exercise redaction without committing credentials.
  const bearer = randomBytes(16).toString('hex');
  const password = randomBytes(16).toString('hex');
  const signature = randomBytes(16).toString('hex');
  const url = new URL('https://example.invalid/file');
  url.username = `fixture-${randomBytes(16).toString('hex')}`;
  url.password = randomBytes(16).toString('hex');
  url.searchParams.set('signature', signature);
  const reason = `Gate exhausted.\nBearer ${bearer}\npassword=${password}\n${url.href}\n` +
    'customer@example.com\n-----BEGIN PRIVATE KEY-----hidden-pem-----END PRIVATE KEY-----\n' +
    '\u0000' + 'detail '.repeat(1000);
  const result = await ensureCycleTechnicalEscalation(context(), { reason });
  expect(result).toEqual({ state: 'recorded', ticket_id: TICKET, email_sent: false, delivery_state: 'unconfigured' });
  const args = rpcArgs();
  expect(args.p_reason.length).toBeLessThanOrEqual(2000);
  expect(args.p_reason).toContain('[REDACTED');
  expect(JSON.stringify(args)).not.toMatch(/hidden-pem|customer@example|\\u0000/);
  for (const value of [bearer, password, url.username, url.password, signature]) {
    expect(JSON.stringify(args)).not.toContain(value);
  }
  expect(deliverHarnessSupportTicket).toHaveBeenCalledWith(expect.objectContaining({ reason: args.p_reason }), context());
});

it('redacts secrets before truncation even when a private-key block crosses the reason limit', async () => {
  fixture();
  await ensureCycleTechnicalEscalation(context(), {
    reason: 'x'.repeat(1900) + '\n-----BEGIN PRIVATE KEY-----' + 'private-key-data'.repeat(300) + '-----END PRIVATE KEY-----',
  });
  expect(rpcArgs().p_reason).not.toContain('private-key-data');
  expect(rpcArgs().p_reason).toContain('[REDACTED_PRIVATE_KEY]');
  expect(rpcArgs().p_reason.length).toBeLessThanOrEqual(2000);
});

it('does not create or send support while independent backlog remains runnable', async () => {
  const h = fixture();
  h.requirement.backlog.items.push({ id: 'independent', status: 'pending', attempts: 0, acceptance: ['Works'] });
  expect(await ensureCycleTechnicalEscalation(context(), { reason: 'Escalate now' }))
    .toEqual({ state: 'not_eligible', reason: 'runnable_work', email_sent: false });
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it('does not deliver a previously stored ticket after independent work becomes runnable', async () => {
  const h = fixture();
  await ensureCycleTechnicalEscalation(context(), {});
  (deliverHarnessSupportTicket as jest.Mock).mockClear();
  h.requirement.backlog.items.push({ id: 'independent', status: 'pending', attempts: 0, acceptance: ['Works'] });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toMatchObject({ state: 'not_eligible' });
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it('does not adopt a historical agent-authored ticket without circuit-break proof', async () => {
  const h = fixture();
  await ensureCycleTechnicalEscalation(context(), {});
  delete h.receipts[0].payload.circuit_breaker;
  (deliverHarnessSupportTicket as jest.Mock).mockClear();
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it('does not send an old circuit ticket after the backlog revision changes', async () => {
  const h = fixture();
  await ensureCycleTechnicalEscalation(context(), {});
  (deliverHarnessSupportTicket as jest.Mock).mockClear();
  h.requirement.backlog_revision++;
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual(UNAVAILABLE);
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it('compares proof semantically after jsonb object-key and array reordering', async () => {
  const h = fixture();
  const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder).reverse()
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorder(entry)])) : value;
  (supabaseAdmin.rpc as jest.Mock).mockImplementationOnce(async (_name, args) => {
    const ticket = reorder(receipt(args));
    h.receipts.push(ticket);
    return { data: { decision: ticket }, error: null };
  });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toMatchObject({ state: 'recorded' });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toMatchObject({ state: 'recorded' });
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
});

it('fails closed when recovery state cannot be verified', async () => {
  const h = fixture();
  h.recoveryReads.push({ data: null, error: { message: 'database unavailable' } });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toEqual({ state: 'unavailable', reason: 'snapshot_unknown', email_sent: false });
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it('rechecks recovery immediately before delivery after a ticket has been persisted', async () => {
  const h = fixture();
  const changed = structuredClone(h.requirement);
  changed.backlog.items.push({ id: 'independent', status: 'pending', attempts: 0, acceptance: ['Works'] });
  h.requirementReads.push({ data: h.requirement }, { data: changed });
  expect(await ensureCycleTechnicalEscalation(context(), {})).toMatchObject({ state: 'not_eligible', reason: 'runnable_work' });
  expect(supabaseAdmin.rpc).toHaveBeenCalledTimes(1);
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});