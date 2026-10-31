import { prepareProcurementApproval } from '../../policy';
import { evaluateProcurementPolicy } from '../evaluate';
import { policyDocumentSchema } from '../schemas';
import { inheritRequestPolicy, inheritedPolicySchema } from '../inherited-policy';

const target = '10000000-0000-4000-8000-000000000001';
const actor = '10000000-0000-4000-8000-000000000002';
const requester = '10000000-0000-4000-8000-000000000003';
const approver = '10000000-0000-4000-8000-000000000004';
const product = '10000000-0000-4000-8000-000000000005';
const category = '10000000-0000-4000-8000-000000000006';
const stage = (extra = {}) => ({ id: 'review', name: 'Review', decisionMode: 'human', approverIds: [approver],
  quorum: { mode: 'all' }, rejectionBehavior: 'veto', execution: 'parallel', allowSelfApproval: false,
  timeoutAction: 'block', ...extra });
const policy = (settings = {}, rules: unknown[] = []) => policyDocumentSchema.parse({ version: 1,
  settings: { fallback: { mode: 'none' }, ...settings }, rules });
const context = (extra: Record<string, unknown> = {}) => ({ policy: { revision: 7, document: policy() },
  evaluated_at: new Date().toISOString(),
  target_id: target, target_version: 2, actor_id: actor, requester_id: requester,
  currency: 'USD', net_amount_minor: 100,
  lines: [{ id: target, productId: product, categoryIds: [category], netAmountMinor: 100 }],
  inherited_requirements: [], minimum_supplier_proposals: 0, supplier_proposals: 3, ...extra });
const rpcFor = (data = context(), valid: unknown = { valid: true }) => jest.fn(async (operation: string) =>
  operation === 'policy.references' ? valid : data);
const args = { id: target, expected_revision: 2 };
const requirement = { id: 'evidence', name: 'Evidence', kind: 'document', classification: 'mandatory',
  milestone: 'award', overridable: false, productIds: [], categoryIds: [], credential: null,
  sourceRuleIds: ['request-rule'], sourceRuleVersions: [1] };
const rule = (extra = {}) => ({ id: 'rule', name: 'Rule', status: 'active', type: 'approval',
  event: 'requisition', stages: [stage()], ...extra });
const simulation = (extra = {}) => ({ event: 'requisition', currency: 'USD', netAmountMinor: 100,
  requesterId: requester, evaluatedAt: '2026-01-01T00:00:00Z', stageActivatedAt: '2026-01-01T00:00:00Z',
  lines: context().lines, ...extra });

describe('trusted procurement orchestration', () => {
  test('pins saved policy and target version, returns only a computed non-authorizing plan', async () => {
    const rpc = rpcFor();
    const result = await prepareProcurementApproval('requests.submit', args, rpc);
    expect(rpc.mock.calls).toEqual([['context.requisition', args], ['policy.references', { policy_revision: 7 }]]);
    expect(result).toMatchObject({ ...args, policy_revision: 7, plan: { status: 'ready', authorized: false, simulationOnly: true } });
    expect(rpc).toHaveBeenCalledTimes(2); // Preparation never persists or votes.
  });

  test.each(['plan', 'policy_revision', 'expected_context', 'actor_id', 'override', 'lines', 'requesterId'])('rejects model-supplied %s', async field => {
    const rpc = rpcFor();
    await expect(prepareProcurementApproval('requests.submit', { ...args, [field]: {} }, rpc)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  test('pins the exact database context without dropping unknown fields or inserting defaults', async () => {
    const snapshot = context({ stored_extra: { revision: 1 } });
    const result = await prepareProcurementApproval('requests.submit', args, rpcFor(snapshot));
    expect(result.expected_context).toEqual(snapshot);
    expect(result.expected_context).toHaveProperty('stored_extra');
  });

  test('uses database evaluation time instead of the API machine clock', async () => {
    const scheduled = policy({}, [rule({ effectiveFrom: '2040-01-01T00:00:00Z' })]);
    const result = await prepareProcurementApproval('requests.submit', args,
      rpcFor(context({ evaluated_at: '2041-01-01T00:00:00Z', policy: { revision: 7, document: scheduled } })));
    expect(result.plan).toMatchObject({ matchedRuleIds: ['rule'] });
    await expect(prepareProcurementApproval('requests.submit', args,
      rpcFor(context({ evaluated_at: undefined })))).rejects.toThrow('could not be verified');
  });

  test('accepts uppercase UUID input against normalized database identifiers', async () => {
    const mixed = 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF';
    const result = await prepareProcurementApproval('requests.submit', { id: mixed, expected_revision: 2 },
      rpcFor(context({ target_id: mixed.toLowerCase() })));
    expect(result.id).toBe(mixed.toLowerCase());
  });

  test.each(['unknown', 'context.requisition', 'requests.save'])('rejects unsupported operation %s', async operation => {
    await expect(prepareProcurementApproval(operation, args, rpcFor())).rejects.toThrow('Unsupported');
  });

  test.each([null, {}, { revision: 0, document: policy() }, { revision: 7, document: {} }])('requires an actual valid saved policy: %j', async saved => {
    await expect(prepareProcurementApproval('requests.submit', args, rpcFor(context({ policy: saved })))).rejects.toThrow();
  });

  test.each([{ target_version: 3 }, { target_id: actor }, { lines: [] }, { net_amount_minor: 101 },
    { lines: [{ ...context().lines[0], netAmountMinor: null }] }])('fails closed on stale or invalid context: %j', async change => {
    await expect(prepareProcurementApproval('requests.submit', args, rpcFor(context(change)))).rejects.toThrow();
  });

  test.each([false, true, null, { valid: false }, {}])('requires affirmative reference verification: %j', async valid => {
    await expect(prepareProcurementApproval('requests.submit', args, rpcFor(context(), valid))).rejects.toThrow('references');
  });

  test('does not reveal database error details', async () => {
    const rpc = jest.fn(async () => { throw new Error('private database diagnostic'); });
    await expect(prepareProcurementApproval('requests.submit', args, rpc)).rejects.toThrow('could not be verified');
    await expect(prepareProcurementApproval('requests.submit', args, rpc)).rejects.not.toThrow('private database');
  });

  test('requires explicit fallback, and blocks self-approval against saved requester', async () => {
    for (const settings of [{ fallback: { mode: 'block' } }, { fallback: { mode: 'approval', stages: [stage({ approverIds: [requester] })] } }]) {
      await expect(prepareProcurementApproval('requests.submit', args,
        rpcFor(context({ policy: { revision: 7, document: policy(settings) } })))).rejects.toThrow('blocked');
    }
  });

  test.each(['award', 'order'])('uses authenticated actor rather than record requester for %s', async event => {
    const document = policy({ fallback: { mode: 'approval', stages: [stage({ approverIds: [actor] })] } });
    await expect(prepareProcurementApproval('approvals.create', { target_id: target, expected_version: 2, event },
      rpcFor(context({ policy: { revision: 7, document } })))).rejects.toThrow('blocked');
  });

  test.each(['requisition', 'publication', 'award', 'order'])('blocks automatic AI for %s', async event => {
    const document = policy({ fallback: { mode: 'approval', stages: [stage({ decisionMode: 'automatic_ai', approverIds: [],
      delegatedAgentId: approver, quorum: { mode: 'first_response' } })] } });
    const operation = event === 'requisition' ? 'requests.submit' : event === 'publication' ? 'tenders.publish' : 'approvals.create';
    const input = event === 'requisition' ? args : event === 'publication' ? { id: target, expected_version: 2 }
      : { target_id: target, expected_version: 2, event };
    await expect(prepareProcurementApproval(operation, input, rpcFor(context({ policy: { revision: 7, document } })))).rejects.toThrow('Automatic AI');
  });

  test.each(['business', 'sequential'])('blocks unsupported %s deadlines including settings inheritance', async kind => {
    const document = policy({ timings: { approval: { kind: 'duration', value: 1, unit: 'days', anchor: 'stage_activation',
      calendar: kind === 'business' ? 'business' : 'calendar', businessCalendarId: 'calendar', timeZone: 'UTC' } },
    fallback: { mode: 'approval', stages: [stage({ execution: kind === 'sequential' ? 'sequential' : 'parallel' })] } });
    await expect(prepareProcurementApproval('requests.submit', args, rpcFor(context({ policy: { revision: 7, document } })))).rejects.toThrow();
  });

  test('preserves requisition requirements for later inherited gates', async () => {
    const { sourceRuleIds: _ids, sourceRuleVersions: _versions, ...outcome } = requirement;
    const document = policy({}, [rule({ type: 'requirements', stages: [], requirements: [outcome] })]);
    const result = await prepareProcurementApproval('requests.submit', args, rpcFor(context({ policy: { revision: 7, document } })));
    expect(result.plan).toMatchObject({ requirements: [{ id: 'evidence', sourceRuleIds: ['rule'] }] });
  });

  test.each(['publication', 'award', 'order'])('blocks inherited unresolved requirements for %s', async event => {
    const operation = event === 'publication' ? 'tenders.publish' : 'approvals.create';
    const input = event === 'publication' ? { id: target, expected_version: 2 } : { target_id: target, expected_version: 2, event };
    await expect(prepareProcurementApproval(operation, input, rpcFor(context({ inherited_requirements: [requirement] })))).rejects.toThrow('requirements');
  });

  test.each(['award', 'order'])('enforces inherited minimum offers for %s', async event => {
    const input = { target_id: target, expected_version: 2, event };
    await expect(prepareProcurementApproval('approvals.create', input,
      rpcFor(context({ minimum_supplier_proposals: 4 })))).rejects.toThrow('minimum supplier offers');
    const result = await prepareProcurementApproval('approvals.create', input, rpcFor(context({ minimum_supplier_proposals: 3 })));
    expect(result.plan).toMatchObject({ minimumSupplierProposals: 3 });
  });

  test('takes the stricter current-event offer minimum rather than weakening it with inherited count', async () => {
    const document = policy({}, [rule({ event: 'award', type: 'supplier_participation', stages: [], minimumSupplierProposals: 5 })]);
    const data = context({ policy: { revision: 7, document }, minimum_supplier_proposals: 2, supplier_proposals: 4 });
    await expect(prepareProcurementApproval('approvals.create', { target_id: target, expected_version: 2, event: 'award' }, rpcFor(data)))
      .rejects.toThrow('minimum supplier offers');
  });

  test('publication retains downstream inherited proposal gate, but blocks current supplier outcomes', async () => {
    const input = { id: target, expected_version: 2 };
    await expect(prepareProcurementApproval('tenders.publish', input, rpcFor(context({ minimum_supplier_proposals: 4 })))).resolves.toBeDefined();
    const document = policy({}, [rule({ event: 'publication', type: 'supplier_participation', stages: [], minimumSupplierProposals: 2 })]);
    await expect(prepareProcurementApproval('tenders.publish', input, rpcFor(context({ policy: { revision: 7, document } })))).rejects.toThrow('Publication supplier');
  });

  test('accepts nullable free-text products for award but explicitly not for order', async () => {
    const data = context({ lines: [{ ...context().lines[0], productId: null, categoryIds: [] }] });
    const input = { target_id: target, expected_version: 2 };
    await expect(prepareProcurementApproval('approvals.create', { ...input, event: 'award' }, rpcFor(data))).resolves.toBeDefined();
    await expect(prepareProcurementApproval('approvals.create', { ...input, event: 'order' }, rpcFor(data))).rejects.toThrow('Free-text');
  });
});

describe('canonical pure domain semantics', () => {
  test('expired deadlines block instead of manufacturing approval', () => {
    const document = policy({ fallback: { mode: 'approval', stages: [stage({ deadline: {
      kind: 'fixed', at: '2025-12-31T23:59:59Z', timeZone: 'UTC',
    }, timeoutAction: 'expire' })] } });
    const result = evaluateProcurementPolicy(document, simulation());
    expect(result.status).toBe('blocked');
    expect(result.authorized).toBe(false);
    expect(result.issues.join(' ')).toContain('never approval');
  });

  test('conflicting requirements cannot overwrite one another', () => {
    const { sourceRuleIds: _ids, sourceRuleVersions: _versions, ...outcome } = requirement;
    const document = policy({}, [rule({ id: 'a', requirements: [outcome] }),
      rule({ id: 'b', requirements: [{ ...outcome, classification: 'scored' }] })]);
    const result = evaluateProcurementPolicy(document, simulation());
    expect(result.status).toBe('blocked');
    expect(result.requirements[0]).toMatchObject({ classification: 'mandatory', sourceRuleIds: ['a', 'b'] });
  });

  test('matches product/category intersection and inclusive amount ranges', () => {
    const document = policy({}, [rule({ scope: { productIds: [product], categoryIds: [category] },
      amount: { operator: 'between', valueMinor: 100, maxMinor: 200, currency: 'USD', basis: 'matching_lines' } })]);
    expect(evaluateProcurementPolicy(document, simulation()).matchedRuleIds).toEqual(['rule']);
    expect(evaluateProcurementPolicy(document, simulation({ lines: [{ ...context().lines[0], categoryIds: [actor] }] })).matchedRuleIds).toEqual([]);
    expect(evaluateProcurementPolicy(document, simulation({ currency: 'EUR' })).status).toBe('blocked');
  });

  test('missing classification cannot evade scoped policy and missing responsible scope blocks', () => {
    const document = policy({}, [rule({ scope: { productIds: [product] } })]);
    expect(evaluateProcurementPolicy(document, simulation({ lines: [{ ...context().lines[0], productId: null }] })).status).toBe('blocked');
    expect(evaluateProcurementPolicy(policy({}, [rule({ scope: { responsibleIds: [actor] } })]), simulation()).status).toBe('blocked');
  });

  test('sorts and combines rules deterministically without weakening offer counts', () => {
    const document = policy({}, ['z', 'a'].map((id, index) => rule({ id, minimumSupplierProposals: index + 2 })));
    const result = evaluateProcurementPolicy(document, simulation());
    expect(result.matchedRuleIds).toEqual(['a', 'z']);
    expect(result.minimumSupplierProposals).toBe(3);
    expect(result.stages).toHaveLength(2);
    expect(result.crossRuleCounting).toBe('independent');
  });

  test('inherited policy merges instead of replacing and rejects malformed requirements', () => {
    const base = evaluateProcurementPolicy(policy(), simulation());
    const result = inheritRequestPolicy({ ...base, minimumSupplierProposals: 4 },
      inheritedPolicySchema.parse({ inherited_requirements: [requirement], minimum_supplier_proposals: 2 }));
    expect(result.requirements).toEqual([requirement]);
    expect(result.minimumSupplierProposals).toBe(4);
    expect(inheritedPolicySchema.safeParse({ inherited_requirements: [{}], minimum_supplier_proposals: 0 }).success).toBe(false);
  });
});