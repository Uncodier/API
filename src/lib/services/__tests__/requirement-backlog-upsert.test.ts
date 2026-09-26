const mockLoadRequirement = jest.fn();
const mockWriteBacklogCas = jest.fn();

// Keep the real CAS replay, serialization helpers, acceptance validation and
// invariants. Only the storage boundary and unrelated lifecycle IO are mocked.
jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {
    from: () => { throw new Error('Unexpected database access in offline test'); },
    rpc: () => { throw new Error('Unexpected database access in offline test'); },
  },
}));
jest.mock('../requirement-backlog-store', () => ({
  ...jest.requireActual('../requirement-backlog-store'),
  loadRequirement: mockLoadRequirement,
  writeBacklogCas: mockWriteBacklogCas,
}));
jest.mock('../requirement-backlog-watchdog', () => ({}));
jest.mock('@/lib/helpers/plan-lifecycle', () => ({
  cancelPlanStepsForBacklogItem: () => {
    throw new Error('Upsert must not perform plan lifecycle IO');
  },
}));

import { upsertBacklogItem } from '../requirement-backlog';
import { BacklogWriteConflictError } from '../requirement-backlog-store';
import {
  compileAcceptanceContract,
  type AcceptanceContractV2,
} from '../requirement-acceptance-contract';
import type {
  BacklogItem,
  BacklogItemStatus,
  RequirementBacklog,
} from '../requirement-backlog-types';

const NOW = '2026-09-26T08:00:00.000Z';
const CREATED = '2026-09-20T00:00:00.000Z';
const UPDATED = '2026-09-23T00:00:00.000Z';
const NEW_ID = '653bd25a-1da9-4ea7-8e55-06179405fc34';

function declaredContract(acceptance: string[]): AcceptanceContractV2 {
  return {
    ...compileAcceptanceContract(acceptance),
    schema_version: 2,
    source: 'declared',
  };
}

function proposal(overrides: Partial<BacklogItem> = {}) {
  const acceptance = overrides.acceptance || [
    'GET /account returns 200',
    'npm run build succeeds',
  ];
  return {
    title: 'Repair account page',
    kind: 'page' as const,
    phase_id: 'build',
    acceptance,
    acceptance_contract: declaredContract(acceptance),
    ...overrides,
  };
}

function item(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'existing-item',
    status: 'pending',
    attempts: 0,
    scope_level: 'full',
    tier: 'core',
    created_at: CREATED,
    updated_at: UPDATED,
    ...proposal(overrides),
  };
}

function lifecycleItem(): BacklogItem {
  return item({
    status: 'needs_review',
    attempts: 4,
    scope_level: 'minimal',
    tier: 'ornamental',
    constraints: ['MUST NOT remove account authentication'],
    touches: ['src/app/account/page.tsx'],
    tool_failures: { judge_evidence_gap: 3, shell: 2 },
    assumptions: ['Waiting for a trusted external user action'],
    depends_on: ['dependency'],
    blocked_by: [{
      blocker_id: 'account-decision',
      category: 'user_decision',
      reason: 'Confirm account behavior',
      resolution_actor: 'user',
      user_action_required: true,
      created_at: UPDATED,
    }],
    review_quarantine: {
      active: true,
      kind: 'verification_exhausted',
      reason: 'Evidence budget exhausted',
      quarantined_at: UPDATED,
      external_action_revision: 9,
    },
    plan_cancellation_pending: {
      reason: 'Cancel old account plan',
      requested_at: UPDATED,
    },
    evidence: {
      schema_version: 1,
      item_id: 'existing-item',
      captured_at: UPDATED,
      critic_passes: 2,
      judge_verdict: 'escalate',
      judge_reason: 'Evidence budget exhausted',
      runtime: { route: '/account', http_status: 200 },
      commit_sha: 'account-commit',
    },
  });
}

function requirement(items: BacklogItem[], revision = 7) {
  return {
    id: 'req-1',
    type: 'app',
    metadata: {},
    backlog_revision: revision,
    external_user_action_revision: 9,
    backlog: {
      schema_version: 1 as const,
      current_phase_id: 'build',
      completion_ratio: 0,
      cycles_spent_total: 12,
      items: structuredClone(items),
    },
  };
}

function readItems(items: BacklogItem[]) {
  const stored = requirement(items);
  mockLoadRequirement.mockImplementation(async () => structuredClone(stored));
  return stored;
}

function withDependency(existing: BacklogItem) {
  return [
    item({
      id: 'dependency', title: 'Account foundation', status: 'done',
      acceptance: ['GET /foundation returns 200'],
    }),
    existing,
  ];
}

function writtenBacklog(call = 0): RequirementBacklog {
  // Exercise the shape actually persisted as JSON, not just object references.
  return JSON.parse(JSON.stringify(mockWriteBacklogCas.mock.calls[call][1]));
}

describe('backlog upsert lifecycle and identity', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
  });
  afterAll(() => jest.useRealTimers());
  beforeEach(() => {
    mockLoadRequirement.mockReset();
    mockWriteBacklogCas.mockReset().mockResolvedValue(8);
  });

  it('preserves the full persisted lifecycle on an existing-ID content update', async () => {
    const existing = lifecycleItem();
    const stored = readItems(withDependency(existing));

    const result = await upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({ id: existing.id, title: 'Clarify account page' }),
    });

    const expected = { ...existing, title: 'Clarify account page', updated_at: NOW };
    expect(result).toEqual(expected);
    expect(writtenBacklog().items[1]).toEqual(expected);
    expect(writtenBacklog().cycles_spent_total).toBe(12);
    expect(stored.backlog.items[1]).toEqual(existing);
  });

  it('treats explicit undefined fields as omitted, including counters and quarantine', async () => {
    const existing = lifecycleItem();
    readItems(withDependency(existing));

    await upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({
        id: existing.id,
        acceptance_contract: undefined,
        constraints: undefined,
        touches: undefined,
        status: undefined,
        attempts: undefined,
        tool_failures: undefined,
        assumptions: undefined,
        scope_level: undefined,
        tier: undefined,
        depends_on: undefined,
        blocked_by: undefined,
        review_quarantine: undefined,
        plan_cancellation_pending: undefined,
        evidence: undefined,
        created_at: undefined,
        updated_at: undefined,
      }),
    });

    expect(writtenBacklog().items[1]).toEqual({ ...existing, updated_at: NOW });
  });

  it('retains explicit existing-ID updates, zero counters and empty collections', async () => {
    const existing = item({ status: 'in_progress', attempts: 2 });
    readItems([existing]);
    const updates = proposal({
      id: existing.id,
      status: 'critic_review',
      attempts: 0,
      constraints: [],
      tool_failures: {},
      assumptions: [],
      touches: [],
      depends_on: [],
      scope_level: 'mvp',
      tier: 'ornamental',
    });

    const result = await upsertBacklogItem({ requirementId: 'req-1', item: updates });

    expect(result).toMatchObject(updates);
    expect(writtenBacklog().items[0]).toMatchObject(updates);
  });

  it('does not apply creation deduplication to an existing-ID update', async () => {
    const existing = item();
    const historicalDuplicate = item({ id: 'old-duplicate', status: 'done' });
    readItems([existing, historicalDuplicate]);

    await upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({ id: existing.id, touches: ['src/app/account/page.tsx'] }),
    });

    expect(writtenBacklog().items).toHaveLength(2);
    expect(writtenBacklog().items[0].id).toBe(existing.id);
    expect(writtenBacklog().items[1]).toEqual(historicalDuplicate);
  });

  it('keeps legitimate creation defaults and explicit seeded done status', async () => {
    readItems([]);
    const pending = await upsertBacklogItem({ requirementId: 'req-1', item: proposal() });
    expect(pending).toMatchObject({
      id: expect.stringMatching(/^[a-f\d-]{36}$/i),
      status: 'pending', attempts: 0, scope_level: 'full', tier: 'core',
    });

    const done = await upsertBacklogItem({
      requirementId: 'req-1',
      allowLegacyContract: true,
      item: proposal({
        status: 'done', acceptance_contract: undefined,
        constraints: ['Keep account auth'], tool_failures: { shell: 1 },
      }),
    });
    expect(done).toMatchObject({
      status: 'done', constraints: ['Keep account auth'], tool_failures: { shell: 1 },
    });
    expect(writtenBacklog(1).completion_ratio).toBe(1);
  });

  it.each([
    'Remediation 2: Repair account page',
    'Bugfix: Repair account page',
    '  REMEDIATION 2 : Bugfix:  REPAIR   ACCOUNT PAGE  ',
  ])('rejects the same task renamed "%s" without creating or rewriting', async (title) => {
    const existing = item({ title: 'Remediation 1: Repair account page' });
    const stored = readItems([existing]);

    await expect(upsertBacklogItem({
      requirementId: 'req-1', item: proposal({ title }),
    })).rejects.toThrow('id="existing-item", status="pending"');

    expect(mockWriteBacklogCas).not.toHaveBeenCalled();
    expect(stored.backlog.items).toEqual([existing]);
  });

  it('also rejects an explicit new UUID with the same task identity', async () => {
    readItems([item()]);
    await expect(upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({ id: NEW_ID, title: 'Remediation 2: Repair account page' }),
    })).rejects.toThrow('id="existing-item", status="pending"');
    expect(mockWriteBacklogCas).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not let a missing legacy contract evade identity (legacy=%s)', async (legacy) => {
    const acceptance = ['GET /account returns 200'];
    readItems([item({
      acceptance,
      acceptance_contract: legacy ? compileAcceptanceContract(acceptance) : undefined,
      touches: ['src/app/account/page.tsx'],
    })]);
    // Different from the legacy parser's page_response interpretation, but no
    // two explicit declarations establish different scope. Omitted touches do
    // not provide a new identity either.
    const acceptance_contract: AcceptanceContractV2 = {
      schema_version: 2,
      source: 'declared',
      criteria: [{
        id: 'account-response', text: acceptance[0],
        all_of: [{
          kind: 'http_response', path: '/account', method: 'GET',
          expected_status: '200', auth: 'unspecified',
        }],
      }],
    };

    await expect(upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({
        title: 'Remediation 2: Repair account page', acceptance, acceptance_contract,
      }),
    })).rejects.toThrow('id="existing-item", status="pending"');
    expect(mockWriteBacklogCas).not.toHaveBeenCalled();
  });

  it('compares full acceptance sets independent of order, duplicates and whitespace', async () => {
    readItems([item()]);
    await expect(upsertBacklogItem({
      requirementId: 'req-1',
      allowLegacyContract: true,
      item: proposal({
        title: 'Remediation 2: Repair account page',
        acceptance: [
          'npm run build succeeds',
          '  GET /account   returns 200  ',
          'GET /account returns 200',
        ],
        acceptance_contract: undefined,
      }),
    })).rejects.toThrow('equivalent item already exists');
    expect(mockWriteBacklogCas).not.toHaveBeenCalled();
  });

  it('ignores declared criterion ids and ordering when obligations are equivalent', async () => {
    const existing = item();
    readItems([existing]);
    const acceptance = [...existing.acceptance].reverse();
    const acceptance_contract = declaredContract(acceptance);
    acceptance_contract.criteria.forEach((criterion, index) => {
      criterion.id = `remediation-criterion-${index}`;
    });

    await expect(upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({ acceptance, acceptance_contract }),
    })).rejects.toThrow('equivalent item already exists');
    expect(mockWriteBacklogCas).not.toHaveBeenCalled();
  });

  it.each<BacklogItemStatus>(['done', 'needs_review', 'rejected'])(
    'does not revive or rewrite a %s duplicate',
    async (status) => {
      const existing = { ...lifecycleItem(), status };
      const stored = readItems(withDependency(existing));

      await expect(upsertBacklogItem({
        requirementId: 'req-1',
        item: proposal({ id: NEW_ID, status: 'pending', title: 'Bugfix: Repair account page' }),
      })).rejects.toThrow(`id="${existing.id}", status="${status}"`);

      expect(mockWriteBacklogCas).not.toHaveBeenCalled();
      expect(stored.backlog.items[1]).toEqual(existing);
    },
  );

  it.each([
    ['new obligations', ['GET /account returns 200', 'POST /api/account returns 201']],
    ['different route', ['GET /settings returns 200', 'npm run build succeeds']],
    ['case-sensitive route', ['GET /Account returns 200', 'npm run build succeeds']],
  ])('allows distinct remediation with %s', async (_label, acceptance) => {
    readItems([item({ status: 'rejected' })]);
    const result = await upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({ id: NEW_ID, title: 'Remediation 2: Repair account page', acceptance }),
    });
    expect(result.id).toBe(NEW_ID);
    expect(writtenBacklog().items).toHaveLength(2);
    expect(writtenBacklog().items[0].status).toBe('rejected');
  });

  it('does not match generic build/test commands alone for differently named tasks', async () => {
    const acceptance = ['npm run build succeeds', 'npm test succeeds'];
    readItems([item({ acceptance })]);
    await upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({ title: 'Remediation 2: Repair settings page', acceptance }),
    });
    expect(writtenBacklog().items).toHaveLength(2);
  });

  it('does not infer identity from empty ornamental acceptance sets', async () => {
    readItems([item({ acceptance: [], tier: 'ornamental', acceptance_contract: undefined })]);
    await upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({ acceptance: [], tier: 'ornamental', acceptance_contract: undefined }),
    });
    expect(writtenBacklog().items).toHaveLength(2);
  });

  it('keeps different routes distinct when only the title identifies the route', async () => {
    const acceptance = ['npm run build succeeds'];
    readItems([item({ title: 'Repair /Account', acceptance })]);
    await upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({ title: 'Bugfix: Repair /account', acceptance }),
    });
    expect(writtenBacklog().items).toHaveLength(2);
  });

  it('keeps equal prose with different declared route claims distinct', async () => {
    const acceptance = ['The destination renders successfully'];
    const routeContract = (path: string): AcceptanceContractV2 => ({
      schema_version: 2,
      source: 'declared',
      criteria: [{
        id: 'destination', text: acceptance[0],
        all_of: [{ kind: 'page_response', path, expected_status: '200' }],
      }],
    });
    readItems([item({ acceptance, acceptance_contract: routeContract('/account') })]);
    await upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({ acceptance, acceptance_contract: routeContract('/settings') }),
    });
    expect(writtenBacklog().items).toHaveLength(2);
  });

  it.each(['touches', 'constraints'] as const)(
    'allows explicitly different %s with otherwise equal identity',
    async (field) => {
      const acceptance = ['npm run build succeeds'];
      readItems([item({ acceptance, [field]: ['src/app/account/page.tsx'] })]);
      await upsertBacklogItem({
        requirementId: 'req-1',
        item: proposal({ acceptance, [field]: ['src/app/settings/page.tsx'] }),
      });
      expect(writtenBacklog().items).toHaveLength(2);
    },
  );

  it.each([undefined, NEW_ID])('checks for a concurrent duplicate on CAS replay (id=%s)', async (id) => {
    const winner = lifecycleItem();
    mockLoadRequirement
      .mockResolvedValueOnce(requirement([], 7))
      .mockResolvedValueOnce(requirement(withDependency(winner), 8));
    mockWriteBacklogCas.mockRejectedValueOnce(new BacklogWriteConflictError('req-1'));

    await expect(upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({ id, title: 'Remediation 2: Repair account page' }),
    })).rejects.toThrow('id="existing-item", status="needs_review"');

    expect(mockLoadRequirement).toHaveBeenCalledTimes(2);
    // Only the first, failed CAS was attempted. Never write over the winner.
    expect(mockWriteBacklogCas).toHaveBeenCalledTimes(1);
    expect(mockWriteBacklogCas.mock.calls[0][2]).toBe(7);
  });

  it('preserves the latest persisted lifecycle when an existing-ID update replays', async () => {
    const latest = lifecycleItem();
    mockLoadRequirement
      .mockResolvedValueOnce(requirement([item({ attempts: 1 })], 7))
      .mockResolvedValueOnce(requirement(withDependency(latest), 8));
    mockWriteBacklogCas
      .mockRejectedValueOnce(new BacklogWriteConflictError('req-1'))
      .mockResolvedValueOnce(9);

    const result = await upsertBacklogItem({
      requirementId: 'req-1',
      item: proposal({
        id: latest.id,
        title: 'Clarify account page',
        status: undefined, attempts: undefined, tool_failures: undefined,
        acceptance_contract: undefined, review_quarantine: undefined,
        plan_cancellation_pending: undefined,
      }),
    });

    const expected = { ...latest, title: 'Clarify account page', updated_at: NOW };
    expect(result).toEqual(expected);
    expect(writtenBacklog(1).items[1]).toEqual(expected);
    expect(mockWriteBacklogCas.mock.calls[1][2]).toBe(8);
  });

  it('allows creation after CAS replay when a concurrent writer added distinct work', async () => {
    const concurrent = item({ acceptance: ['GET /settings returns 200'] });
    mockLoadRequirement
      .mockResolvedValueOnce(requirement([], 7))
      .mockResolvedValueOnce(requirement([concurrent], 8));
    mockWriteBacklogCas
      .mockRejectedValueOnce(new BacklogWriteConflictError('req-1'))
      .mockResolvedValueOnce(9);

    await upsertBacklogItem({
      requirementId: 'req-1', item: proposal({ id: NEW_ID }),
    });

    expect(writtenBacklog(1).items).toHaveLength(2);
    expect(writtenBacklog(1).items[0]).toEqual(concurrent);
    expect(writtenBacklog(1).items[1].id).toBe(NEW_ID);
    expect(mockWriteBacklogCas.mock.calls[1][2]).toBe(8);
  });
});