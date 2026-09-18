import { v5 as uuidv5 } from 'uuid';
import type {
  InteractionFinding,
  InteractionSignal,
} from '../step-interaction-audit';
import { applyInteractionBacklogPolicy } from '../step-interaction-backlog';

const mockListBacklog = jest.fn();
const mockUpsertBacklogItem = jest.fn();
const mockSuspendItemForRemediation = jest.fn();
const mockResolveRequirementScopePolicy = jest.fn();

jest.mock('@/lib/services/requirement-backlog', () => ({
  listBacklog: mockListBacklog,
  suspendItemForRemediation: mockSuspendItemForRemediation,
  upsertBacklogItem: mockUpsertBacklogItem,
}));

jest.mock('@/lib/services/requirement-scope-policy', () => ({
  resolveRequirementScopePolicy: mockResolveRequirementScopePolicy,
}));

function backlogItem(
  id: string,
  status: string,
  acceptance: string[] = [],
) {
  return {
    id,
    title: id,
    kind: 'page',
    phase_id: 'implementation',
    acceptance,
    constraints: [],
    touches: [],
    status,
    attempts: 0,
    scope_level: 'full',
  };
}

function missingRoute(): InteractionFinding {
  return {
    fingerprint: 'missing-pricing',
    kind: 'broken_link',
    file: 'src/components/Header.tsx',
    line: 4,
    element: 'Link',
    target: '/pricing',
    reason: 'No Next.js page matches /pricing',
    confidence: 'high',
    introduced_by_step: true,
    disposition: 'create_backlog',
  };
}

function inertControl(): InteractionFinding {
  return {
    fingerprint: 'inert-save',
    kind: 'inert_control',
    file: 'src/components/Header.tsx',
    line: 8,
    element: 'button',
    reason: 'Control has no action',
    confidence: 'high',
    introduced_by_step: true,
    disposition: 'repair',
  };
}

function signal(findings: InteractionFinding[]): InteractionSignal {
  return {
    ok: false,
    findings,
    blocking_count: findings.length,
    deferred_count: 0,
    warning_count: 0,
    summary: `${findings.length} blocking`,
  };
}

describe('interaction remediation integrity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListBacklog.mockResolvedValue({
      backlog: {
        current_phase_id: 'implementation',
        items: [backlogItem('current', 'in_progress')],
      },
    });
    mockResolveRequirementScopePolicy.mockResolvedValue({
      strict: false,
      reason: 'scope allows expansion',
    });
    mockUpsertBacklogItem.mockResolvedValue({ id: 'new-item' });
    mockSuspendItemForRemediation.mockResolvedValue({
      ...backlogItem('current', 'pending'),
      depends_on: ['new-item'],
    });
  });

  it('keeps mixed findings blocking without suspending the active item', async () => {
    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([missingRoute(), inertControl()]),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      blocking_count: 1,
      deferred_count: 1,
      remediation_required: true,
      active_item_suspended: false,
    }));
    expect(mockSuspendItemForRemediation).not.toHaveBeenCalled();
  });

  it('does not report a handoff unless the parent was actually suspended', async () => {
    mockSuspendItemForRemediation.mockResolvedValue(
      backlogItem('current', 'in_progress'),
    );

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([missingRoute()]),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      blocking_count: 1,
      deferred_count: 0,
      remediation_required: false,
      active_item_suspended: false,
    }));
  });

  it('restores a route required by a done item even under strict scope', async () => {
    mockListBacklog.mockResolvedValue({
      backlog: {
        current_phase_id: 'implementation',
        items: [
          backlogItem('current', 'in_progress'),
          backlogItem(
            'completed-pricing',
            'done',
            ['GET /pricing renders the contracted pricing screen'],
          ),
        ],
      },
    });
    mockResolveRequirementScopePolicy.mockResolvedValue({
      strict: true,
      reason: 'active item scope is minimal',
    });

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([missingRoute()]),
    });

    const remediation = mockUpsertBacklogItem.mock.calls[0][0].item;
    expect(mockResolveRequirementScopePolicy).not.toHaveBeenCalled();
    expect(remediation).toEqual(expect.objectContaining({
      id: uuidv5(
        'interaction-missing-screen:requirement:/pricing',
        uuidv5.URL,
      ),
      title: 'Implement missing /pricing screen',
      assumptions: expect.arrayContaining([
        '[interaction-resolution:implement]',
      ]),
    }));
    expect(result.findings[0]).toEqual(expect.objectContaining({
      disposition: 'deferred',
      backlog_item_id: 'new-item',
    }));
  });

  it('creates restoration instead of deferring to a needs-review owner', async () => {
    mockListBacklog.mockResolvedValue({
      backlog: {
        current_phase_id: 'implementation',
        items: [
          backlogItem('current', 'in_progress'),
          backlogItem(
            'reviewed-pricing',
            'needs_review',
            ['GET /pricing renders the contracted pricing screen'],
          ),
        ],
      },
    });
    mockResolveRequirementScopePolicy.mockResolvedValue({
      strict: true,
      reason: 'active item scope is minimal',
    });

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([missingRoute()]),
    });

    expect(mockUpsertBacklogItem).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({
        title: 'Implement missing /pricing screen',
      }),
    }));
    expect(result.findings[0].backlog_item_id).toBe('new-item');
  });
});
