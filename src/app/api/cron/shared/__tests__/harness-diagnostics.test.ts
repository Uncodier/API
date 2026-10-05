import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { loadHarnessScope, sanitizeHarnessData } from '@/lib/services/harness-diagnostics/context';
import { readHarnessEvents } from '@/lib/services/harness-diagnostics/events';
import { inspectHarness } from '@/lib/services/harness-diagnostics/inspect';
import { decideHarness, harnessDecisionSchema } from '@/lib/services/harness-diagnostics/decisions';
import { deliverHarnessSupportTicket } from '@/lib/services/harness-diagnostics/support';
import { createHarnessDiagnosticTools, refreshHarnessToolManifest } from '@/lib/services/harness-diagnostics/tools';
import { restrictToolsForEvidenceCollection } from '../single-turn-helpers';
import { routeTools } from '@/app/api/agents/tools/router/assistantProtocol';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HARNESS_SOURCE_ALLOWLIST } from '@/lib/services/harness-diagnostics/reference';

jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('@/lib/services/harness-diagnostics/support', () => ({ deliverHarnessSupportTicket: jest.fn() }));
jest.mock('@/lib/services/embeddings-service', () => ({ EmbeddingsService: {} }));

const site = '00000000-0000-4000-8000-000000000001';
const instance = '00000000-0000-4000-8000-000000000002';
const req = '00000000-0000-4000-8000-000000000003';
const other = '00000000-0000-4000-8000-000000000004';
const event = '00000000-0000-4000-8000-000000000005';
const request = '00000000-0000-4000-8000-000000000006';
const time = '2026-10-01T00:00:00.000Z';
const context = () => ({ siteId: site, instanceId: instance, requirementId: req, runtime: 'assistant', toolNames: ['harness_inspect'] });
const row = () => ({ id: req, site_id: site, status: 'blocked', updated_at: time, backlog_revision: 2,
  metadata: { runner_instance_id: instance }, backlog: { items: [{ id: 'base', status: 'pending', acceptance: ['Works'] }] } });
const approachDecision = (decision: 'approve_backlog' | 'adapt_backlog') => ({
  decision, request_id: request, expected_backlog_revision: 2, expected_updated_at: time,
  item_id: 'base', reason: 'Preserve the existing contract', evidence_log_ids: [event], verification: 'Run tests',
  ...(decision === 'adapt_backlog' ? { implementation_instructions: 'Use the existing scoped API',
    equivalence_reason: 'Preserves the original behavior',
    acceptance_mapping: [{ criterion_index: 0, implementation: 'Existing scoped API', verification: 'Test original behavior' }] } : {}),
});
function chain(data: any, error: any = null) {
  const q: any = { then: (resolve: any, reject: any) => Promise.resolve({ data, error }).then(resolve, reject) };
  for (const name of ['select', 'eq', 'in', 'or', 'contains', 'order', 'limit', 'gte', 'lte', 'ilike', 'maybeSingle', 'update']) q[name] = jest.fn(() => q);
  return q;
}
function fixture(overrides: Record<string, any> = {}) {
  const queues: Record<string, any[]> = {};
  const defaults: Record<string, any> = { remote_instances: { id: instance, site_id: site, status: 'running' },
    requirements: row(), instance_plans: [], instance_logs: [], requirement_migration_lifecycle: [],
    requirement_migration_diagnostics: [], requirement_harness_decisions: [], requirement_migration_reconciliations: [],
    requirement_migration_reconciliation_resumes: [] };
  const calls: Record<string, any[]> = {};
  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    const value = queues[table]?.length ? queues[table].shift() : table in overrides ? overrides[table] : defaults[table];
    const q = chain(value?.__error ? null : value, value?.__error);
    (calls[table] ||= []).push(q);
    return q;
  });
  return { calls, queues };
}
beforeEach(() => jest.clearAllMocks());

it('allows diagnostics of blocked work without requiring a runnable lease; binds site and instance', async () => {
  const h = fixture();
  expect((await loadHarnessScope(context())).requirement.status).toBe('blocked');
  expect(h.calls.requirements[0].eq).toHaveBeenCalledWith('site_id', site);
  expect(h.calls.remote_instances[0].eq).toHaveBeenCalledWith('id', instance);
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
});

it('denies unassociated instances and ambiguous implicit requirements', async () => {
  fixture({ requirements: { ...row(), metadata: { runner_instance_id: other } } });
  await expect(loadHarnessScope(context())).rejects.toThrow('not associated');
  fixture({ requirements: [{ id: req }, { id: other }] });
  await expect(loadHarnessScope({ ...context(), requirementId: undefined })).rejects.toThrow('unambiguous');
});

it('finds the originating blocker in another instance and pages without exposing conflicting requirements', async () => {
  const h = fixture({ instance_logs: [
    { id: event, instance_id: other, created_at: time, tool_name: 'requirement_backlog', message: 'sandbox missing', tool_args: { requirement_id: req } },
    { id: request, instance_id: instance, created_at: time, details: { requirement_id: req }, tool_args: { requirement_id: other } },
    { id: instance, created_at: time, details: { requirement_id: req } },
  ] });
  const result: any = await readHarnessEvents(context(), { action: 'list', limit: 2, tool_name: 'requirement_backlog' });
  expect(result.events).toEqual([expect.objectContaining({ id: event, instance_id: other })]);
  expect(result.next_cursor.id).toBe(request);
  expect(h.calls.instance_logs[0].eq).not.toHaveBeenCalledWith('instance_id', instance);
  expect(h.calls.instance_logs[0].or).toHaveBeenCalledWith(expect.stringContaining(req));
});

it('redacts full event payloads and rejects model scope overrides before I/O', async () => {
  const marker = randomBytes(16).toString('hex');
  fixture({ instance_logs: { id: event, instance_id: other, details: { requirement_id: req },
    tool_args: { authorization: `Bearer ${marker}`, text: `password=${marker}` }, tool_result: { token: `sb_secret_${marker}` } } });
  const result: any = await readHarnessEvents(context(), { action: 'read', log_id: event });
  expect(result.content).not.toContain(marker);
  jest.clearAllMocks();
  await expect(readHarnessEvents(context(), { action: 'list', site_id: other })).rejects.toThrow();
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('distinguishes caller tools from worker health and unknown lifecycle data', async () => {
  fixture({ requirement_migration_lifecycle: { __error: { message: 'secret internal error' } } });
  const result: any = await inspectHarness(context());
  expect(result.runtime).toMatchObject({ sandbox_tools_exposed: false, sandbox_health: 'not_probed', other_worker_capabilities: 'unknown' });
  expect(result.migrations.available).toBe(false);
  expect(JSON.stringify(result)).not.toContain('secret internal error');
});

it.each(['assistant', 'coordinator', 'migration_diagnostic', 'evidence_collection', 'cron_executor'])(
  'keeps absent tools invocation-local in %s despite a running runner, plan flags and a migration hold', async runtime => {
    const requirement = { ...row(), metadata: { runner_instance_id: other, assistant_origin_instance_id: instance } };
    const hold = { file: 'migrations/0001.sql', state: 'platform_review', version: 3,
      reason: 'A pending migration has no requirement-bound implementation plan; technical review is required.' };
    const h = fixture({ requirements: requirement, requirement_migration_lifecycle: [hold],
      instance_plans: [{ id: request, instance_id: other, status: 'in_progress',
        steps: [{ id: 'step-1', status: 'pending', requires_sandbox: true, skill: 'makinari-rol-backend' }] }] });
    h.queues.remote_instances = [{ id: instance, site_id: site }, [{ id: other, status: 'running' }]];
    const result = await inspectHarness({ ...context(), runtime });
    expect(result.runtime).toMatchObject({ kind: runtime, scope: 'current_invocation', observation: 'exposed_tool_manifest',
      exposed_tools: ['harness_inspect'], sandbox_tools_exposed: false, sandbox_health: 'not_probed',
      runner_provisioning: 'not_observed', other_worker_capabilities: 'unknown' });
    expect(result.runtime.note).toContain('not that runner provisioning failed or other workers cannot execute');
    expect(result.runtime.next_check).toContain('missing observations remain unknown');
    expect(result.execution.owner_instance_id).toBe(other);
    expect(result.instances.records).toEqual([{ id: other, status: 'running' }]);
    expect(result.requirement.status).toBe('blocked');
    expect(result.migrations.records).toEqual([hold]);
    expect(result.migrations.note).toContain('not proof that SQL is sensitive, already applied or validated');
    expect(result.migrations.note).toContain('diagnostics do not release holds');
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
    for (const queries of Object.values(h.calls)) for (const query of queries) expect(query.update).not.toHaveBeenCalled();
  },
);

it.each([
  ['cron_executor', ['sandbox_run_command', 'sandbox_read_file', 'sandbox_read_file'], true],
  ['evidence_collection', ['sandbox_read_file'], true],
  ['migration_diagnostic', ['migration_read_context'], false],
  ['assistant', ['tools', 'skill_lookup', 'not_sandbox_run_command'], false],
] as const)('reports the exact %s tool surface without promoting exposure to health or authorization', async (runtime, names, exposed) => {
  fixture();
  const toolNames = ['harness_inspect', ...names];
  const original = [...toolNames];
  const result = await inspectHarness({ ...context(), runtime, toolNames });
  expect(result.runtime).toMatchObject({ sandbox_tools_exposed: exposed, sandbox_health: 'not_probed',
    runner_provisioning: 'not_observed', other_worker_capabilities: 'unknown',
    exposed_tools: Array.from(new Set(toolNames)).sort() });
  expect(result.runtime.note).toContain('not that every sandbox operation is available, healthy or authorized');
  expect(toolNames).toEqual(original);
});

it('does not transfer tool exposure between separate invocations on the same instance', async () => {
  fixture();
  const chatContext = context();
  const workerContext = context();
  type InvocationTool = { name: string; execute: (args: unknown) => Promise<any> };
  const chatTools = refreshHarnessToolManifest(createHarnessDiagnosticTools(chatContext), 'assistant');
  const workerTools = refreshHarnessToolManifest<InvocationTool>([...createHarnessDiagnosticTools(workerContext),
    { name: 'sandbox_read_file', execute: jest.fn(async () => ({})) }], 'cron_executor');
  const inspect = (tools: typeof workerTools) => tools.find(tool => tool.name === 'harness_inspect')!.execute({});
  expect((await inspect(chatTools)).runtime.sandbox_tools_exposed).toBe(false);
  expect((await inspect(workerTools)).runtime.sandbox_tools_exposed).toBe(true);
  const restrictedWorkerTools = refreshHarnessToolManifest(workerTools.filter(tool => !tool.name.startsWith('sandbox_')), 'evidence_collection');
  expect((await inspect(restrictedWorkerTools)).runtime.sandbox_tools_exposed).toBe(false);
  expect((await inspect(chatTools)).runtime.kind).toBe('assistant');
});

it('exposes scoped reconciliation summaries, never selects the private historical SQL or operator prose', async () => {
  const h = fixture({ requirement_migration_reconciliations: [{ id: request, file: 'migrations/0001.sql' }] });
  const result = await inspectHarness(context());
  expect(result.migration_reconciliations).toEqual({ available: true,
    records: [{ id: request, file: 'migrations/0001.sql' }] });
  const query = h.calls.requirement_migration_reconciliations[0];
  expect(query.eq).toHaveBeenCalledWith('site_id', site);
  expect(query.eq).toHaveBeenCalledWith('requirement_id', req);
  const selected = query.select.mock.calls[0][0];
  expect(selected).not.toMatch(/prior_lifecycle|operator_id|reason|evidence/);
  fixture({ requirement_migration_reconciliations: { __error: { message: 'not deployed' } } });
  expect((await inspectHarness(context())).migration_reconciliations.available).toBe(false);
});

it('exposes persisted HTTP fixtures and repair receipts instead of guessing from repository tests', async () => {
  fixture({ instance_plans: [{ id: request, instance_id: instance, steps: [{ id: 'step', status: 'failed',
    test_command: 'npm test', retry_count: 2, metadata: { validation_targets: [{ kind: 'api',
      path: '/api/webhooks/makinari', method: 'POST', payload: { asset_id: '123', api_key: 'sensitive-value' }, expected_statuses: [200] }],
      repair_run: { status: 'exhausted', attempt_count: 3 } } }] }] });
  const result = await inspectHarness(context());
  const step = result.plans.records[0].steps[0];
  expect(step).toMatchObject({ test_command: 'npm test', retry_count: 2,
    repair_run: { status: 'exhausted', attempt_count: 3 }, validation_targets: [{ payload: { asset_id: '123', api_key: '[REDACTED]' } }] });
  expect(JSON.stringify(result)).not.toContain('sensitive-value');
});

it('rejects fake evidence and changes to acceptance/scope before a decision mutation', async () => {
  fixture();
  const decision = { decision: 'approve_backlog', request_id: request, expected_backlog_revision: 2,
    expected_updated_at: time, item_id: 'base', reason: 'Runnable', evidence_log_ids: [event], verification: 'Run tests' };
  await expect(decideHarness(context(), decision)).rejects.toThrow('out-of-scope');
  await expect(decideHarness(context(), { ...decision, acceptance: ['weaker'] })).rejects.toThrow();
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
});

it('resolves redacted acceptance by server-side index without weakening or leaking the original criterion', async () => {
  const criterion = 'Send confirmation to help@example.com';
  fixture({ requirements: { ...row(), backlog: { items: [{ id: 'base', acceptance: [criterion] }] } },
    instance_logs: [{ id: event, details: { requirement_id: req } }] });
  (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({ data: { decision: { id: event, requirement_id: req, instance_id: instance,
    decision: 'adapt_backlog', request_id: request, status: 'applied' } }, error: null });
  const result = await decideHarness(context(), { decision: 'adapt_backlog', request_id: request,
    expected_updated_at: time, expected_backlog_revision: 2, item_id: 'base', reason: 'Use configured mail transport',
    evidence_log_ids: [event], verification: 'Verify delivery', implementation_instructions: 'Use the existing email integration',
    equivalence_reason: 'Preserves the configured recipient and confirmation',
    acceptance_mapping: [{ criterion_index: 0, implementation: 'Existing mail sender', verification: 'Assert recipient matches original criterion' }] });
  expect(supabaseAdmin.rpc).toHaveBeenCalledWith('record_harness_diagnostic_decision', expect.objectContaining({
    p_payload: expect.objectContaining({ acceptance_mapping: [expect.objectContaining({ criterion })] }),
  }));
  expect(JSON.stringify(result)).not.toContain('help@example.com');
});

it.each([
  { label: 'scoped evidence', evidence_log_ids: [event] },
  { label: 'no evidence', evidence_log_ids: [] },
])('rejects legacy escalation with $label before any I/O, even for cast direct calls', async ({ evidence_log_ids }) => {
  fixture();
  const legacy = { decision: 'escalate_support', request_id: request,
    expected_updated_at: time, expected_backlog_revision: 2, reason: 'Missing operational recovery',
    evidence_log_ids, verification: 'Worker executes the pending step', impact: 'Cannot continue',
    attempted_alternatives: ['Inspected runner and lifecycle'], requested_action: 'Repair dispatch' };
  expect(harnessDecisionSchema.safeParse(legacy).success).toBe(false);
  await expect(decideHarness(context(), legacy as unknown as z.infer<typeof harnessDecisionSchema>)).rejects.toBeInstanceOf(z.ZodError);
  const tool = createHarnessDiagnosticTools(context()).find(entry => entry.name === 'harness_decide')!;
  await expect(tool.execute(legacy)).rejects.toBeInstanceOf(z.ZodError);
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
});

it.each(['runner_instance_id', 'assistant_origin_instance_id'])('preserves scoped approval for %s without delivery or execution', async ownerKey => {
  fixture({ requirements: { ...row(), metadata: { [ownerKey]: instance } },
    instance_logs: [{ id: event, details: { requirement_id: req } }] });
  (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({ data: { id: event, requirement_id: req, instance_id: instance,
    decision: 'approve_backlog', request_id: request, status: 'recorded' }, error: null });
  const result = await decideHarness(context(), approachDecision('approve_backlog'));
  expect(result).toMatchObject({ success: true, execution_started: false, acceptance_approved: false,
    decision: 'approve_backlog' });
  expect(result).not.toHaveProperty('support_delivery');
  expect(deliverHarnessSupportTicket).not.toHaveBeenCalled();
  expect(supabaseAdmin.rpc).toHaveBeenCalledWith('record_harness_diagnostic_decision', {
    p_site_id: site, p_instance_id: instance, p_requirement_id: req, p_request_id: request,
    p_expected_backlog_revision: 2, p_expected_updated_at: time, p_decision: 'approve_backlog', p_item_id: 'base',
    p_reason: 'Preserve the existing contract', p_payload: { evidence_log_ids: [event], verification: 'Run tests' },
  });
});

describe.each(['approve_backlog', 'adapt_backlog'] as const)('%s guards', decision => {
  it('denies authoring by an associated non-owner instance', async () => {
    fixture({ requirements: { ...row(), metadata: { runner_instance_id: other } },
      instance_plans: [{ id: request, instance_id: instance }] });
    await expect(decideHarness(context(), approachDecision(decision))).rejects.toThrow('Only the requirement owner');
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { evidence_log_ids: [], error: 'Read supporting requirement events' },
    { evidence_log_ids: [event, event], error: 'Evidence IDs must be unique' },
  ])('rejects invalid evidence: $error', async ({ evidence_log_ids, error }) => {
    fixture({ instance_logs: [{ id: event, details: { requirement_id: req } }] });
    await expect(decideHarness(context(), { ...approachDecision(decision), evidence_log_ids })).rejects.toThrow(error);
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  });

  it('rejects sensitive authored content before persistence', async () => {
    fixture({ instance_logs: [{ id: event, details: { requirement_id: req } }] });
    const credential = randomBytes(16).toString('hex');
    const input = { ...approachDecision(decision), reason: `Bearer ${credential}` };
    await expect(decideHarness(context(), input)).rejects.toThrow('Remove sensitive values');
    expect(JSON.stringify(sanitizeHarnessData(input))).not.toContain(credential);
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
  });
});

it.each([
  { label: 'incomplete', indices: [0] },
  { label: 'reordered', indices: [1, 0] },
  { label: 'duplicate', indices: [0, 0] },
])('rejects $label acceptance mapping', async ({ indices }) => {
  fixture({ requirements: { ...row(), backlog: { items: [{ id: 'base', acceptance: ['Works', 'Preserves authorization'] }] } },
    instance_logs: [{ id: event, details: { requirement_id: req } }] });
  await expect(decideHarness(context(), { ...approachDecision('adapt_backlog'),
    acceptance_mapping: indices.map(criterion_index => ({ criterion_index, implementation: 'Scoped API', verification: 'Run tests' })),
  })).rejects.toThrow('Map every canonical acceptance criterion exactly once');
  expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
});

it('keeps read tools direct during restricted repair and refreshes the actual tool manifest', async () => {
  fixture();
  const ctx = context();
  const all = routeTools([...createHarnessDiagnosticTools(ctx),
    { name: 'sandbox_write_file', description: 'Test-only write tool', parameters: { type: 'object' }, execute: jest.fn() }]);
  expect(all.every(tool => tool.parameters.type === 'object')).toBe(true);
  expect(all.find(tool => tool.name === 'harness_decide')?.parameters.properties.decision.enum)
    .toEqual(['approve_backlog', 'adapt_backlog']);
  const decisionTool = all.find(tool => tool.name === 'harness_decide')!;
  expect(decisionTool.parameters.required).toContain('item_id');
  expect(JSON.stringify(decisionTool.parameters)).not.toMatch(/escalate_support|impact|requested_action|attempted_alternatives/);
  expect(decisionTool.description).toContain('agents cannot request support tickets');
  const restricted = refreshHarnessToolManifest(restrictToolsForEvidenceCollection(all, 'Failure kind: evidence_gap'), 'evidence_collection');
  expect(restricted.map(tool => tool.name)).toEqual(['harness_inspect', 'harness_events', 'harness_reference', 'harness_source']);
  const result: any = await restricted[0].execute({});
  expect(result.runtime.exposed_tools).not.toContain('harness_decide');
  expect(result.runtime).toMatchObject({ kind: 'evidence_collection', sandbox_tools_exposed: false,
    exposed_tools: ['harness_events', 'harness_inspect', 'harness_reference', 'harness_source'] });
  expect(all.find(tool => tool.name === 'sandbox_write_file')!.execute).not.toHaveBeenCalled();
});

it.each(['http:', 'https:'])('redacts nested secrets and each URL credential before email redaction (%s)', protocol => {
  // Generate synthetic credentials only in memory; never contact this reserved host.
  const credential = randomBytes(16).toString('hex');
  const token = randomBytes(16).toString('hex');
  const url = new URL(`${protocol}//example.invalid/file`);
  url.username = `fixture-${randomBytes(16).toString('hex')}`;
  url.password = randomBytes(16).toString('hex');
  url.searchParams.set('token', token);
  const value = sanitizeHarnessData({ details: { credentials: credential, url: url.href, text: `Bearer ${credential}` } });
  expect(value).toEqual({ details: {
    credentials: '[REDACTED]', url: `${protocol}//[REDACTED]@example.invalid/file?token=[REDACTED]`, text: 'Bearer [REDACTED]',
  } });
  for (const marker of [credential, token, url.username, url.password]) {
    expect(JSON.stringify(value)).not.toContain(marker);
  }
});

it('keeps the static harness map available when the database is down', async () => {
  (supabaseAdmin.from as jest.Mock).mockImplementation(() => { throw new Error('Database down'); });
  const reference = createHarnessDiagnosticTools(context()).find(tool => tool.name === 'harness_reference')!;
  expect(await reference.execute({ topic: 'runtime' })).toMatchObject({ read_only: true });
  expect(supabaseAdmin.from).not.toHaveBeenCalled();
});

it('ships precisely the allowlisted source paths through Next file tracing', () => {
  const reference = readFileSync(resolve(process.cwd(), 'src/lib/services/harness-diagnostics/reference.ts'), 'utf8');
  const traced = Array.from(reference.matchAll(/^  \w+: '((?:src|supabase)\/[^']+)',?$/gm), match => match[1]);
  expect(traced).toEqual(HARNESS_SOURCE_ALLOWLIST);
  const config = readFileSync(resolve(process.cwd(), 'next.config.mjs'), 'utf8');
  expect(config).toContain("'/api/robots/instance/assistant': harnessSourceFiles");
  expect(config).toMatch(/workflow\/v1\/step'[\s\S]*?\.\.\.harnessSourceFiles/);
});

it('marks oversized inspection views partial instead of implying complete evidence', async () => {
  fixture({ requirements: { ...row(), instructions: 'x'.repeat(20000) } });
  const result = await inspectHarness(context());
  expect(result.response_truncated).toBe(true);
  expect(result.specification).toContain('[TRUNCATED:');
});