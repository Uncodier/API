import type {
  InteractionFinding,
  InteractionSignal,
} from '../step-interaction-audit';
import { applyInteractionBacklogPolicy } from '../step-interaction-backlog';
import { routesFromAcceptance } from '@/lib/services/requirement-acceptance';

const mockListBacklog = jest.fn();
const mockUpsertBacklogItem = jest.fn();
const mockIsItemTerminal = jest.fn();
const mockResolveRequirementScopePolicy = jest.fn();

jest.mock('@/lib/services/requirement-backlog', () => ({
  isItemTerminal: mockIsItemTerminal,
  listBacklog: mockListBacklog,
  upsertBacklogItem: mockUpsertBacklogItem,
}));

jest.mock('@/lib/services/requirement-scope-policy', () => ({
  resolveRequirementScopePolicy: mockResolveRequirementScopePolicy,
}));

const file = 'src/components/Header.tsx';

function missingRoute(
  target = '/pricing',
  sourceFile = file,
): InteractionFinding {
  return {
    fingerprint: `broken-link-${target}`,
    kind: 'broken_link',
    file: sourceFile,
    line: 4,
    element: 'Link',
    label: 'Pricing',
    target,
    reason: `No Next.js page matches ${target}`,
    confidence: 'high',
    introduced_by_step: true,
    disposition: 'create_backlog',
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

function currentItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'current',
    title: 'Current item',
    kind: 'page',
    phase_id: 'implementation',
    acceptance: [],
    constraints: [],
    touches: [],
    status: 'in_progress',
    attempts: 0,
    scope_level: 'full',
    ...overrides,
  };
}

describe('interaction backlog policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsItemTerminal.mockReturnValue(false);
    mockListBacklog.mockResolvedValue({
      backlog: {
        current_phase_id: 'implementation',
        items: [currentItem()],
      },
    });
    mockResolveRequirementScopePolicy.mockResolvedValue({
      strict: false,
      reason: 'requirement allows backlog expansion',
    });
    mockUpsertBacklogItem.mockResolvedValue({ id: 'new-item' });
  });

  it('immediately creates and defers a missing-page item for flexible scope', async () => {
    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([missingRoute()]),
    });

    expect(mockUpsertBacklogItem).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        title: 'Implement missing /pricing screen',
        kind: 'page',
        status: 'pending',
        assumptions: expect.arrayContaining([
          '[interaction-resolution:implement]',
        ]),
      }),
    }));
    const implementationItem = mockUpsertBacklogItem.mock.calls[0][0].item;
    expect(routesFromAcceptance(implementationItem.acceptance)).toEqual([
      '/pricing',
    ]);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      blocking_count: 0,
      deferred_count: 1,
    }));
    expect(result.findings[0]).toEqual(expect.objectContaining({
      disposition: 'deferred',
      backlog_item_id: 'new-item',
    }));
  });

  it('creates one item for duplicate links to one route', async () => {
    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([
        missingRoute(),
        missingRoute('/pricing', 'src/components/Footer.tsx'),
      ]),
    });

    expect(result.ok).toBe(true);
    expect(result.deferred_count).toBe(2);
    expect(mockUpsertBacklogItem).toHaveBeenCalledTimes(1);
  });

  it('creates a removal item when adding the route would exceed strict scope', async () => {
    mockListBacklog.mockResolvedValue({
      backlog: {
        current_phase_id: 'implementation',
        items: [currentItem({
          acceptance: ['GET / renders the requested landing page'],
          touches: ['src/app/page.tsx'],
          scope_level: 'minimal',
        })],
      },
    });
    mockResolveRequirementScopePolicy.mockResolvedValue({
      strict: true,
      reason: 'active backlog item scope is minimal',
    });

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([missingRoute('/legal/privacy')]),
    });

    expect(mockUpsertBacklogItem).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({
        title: 'Remove out-of-scope /legal/privacy navigation',
        kind: 'component',
        touches: [file],
        assumptions: expect.arrayContaining([
          '[interaction-resolution:remove]',
        ]),
      }),
    }));
    const removalItem = mockUpsertBacklogItem.mock.calls[0][0].item;
    expect(routesFromAcceptance(removalItem.acceptance)).toEqual([]);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      blocking_count: 0,
      deferred_count: 1,
    }));
  });

  it('keeps an explicitly required route on the current item', async () => {
    mockListBacklog.mockResolvedValue({
      backlog: {
        current_phase_id: 'implementation',
        items: [currentItem({
          acceptance: ['GET /pricing renders the pricing screen'],
          scope_level: 'minimal',
        })],
      },
    });

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([missingRoute()]),
    });

    expect(mockResolveRequirementScopePolicy).not.toHaveBeenCalled();
    expect(mockUpsertBacklogItem).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('aggregates every source file into one strict-scope removal item', async () => {
    mockResolveRequirementScopePolicy.mockResolvedValue({
      strict: true,
      reason: 'requirement has an explicit budget',
    });

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([
        missingRoute(),
        missingRoute('/pricing', 'src/components/Footer.tsx'),
      ]),
    });

    expect(mockUpsertBacklogItem).toHaveBeenCalledTimes(1);
    expect(mockUpsertBacklogItem).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({
        touches: [
          'src/components/Header.tsx',
          'src/components/Footer.tsx',
        ],
      }),
    }));
    expect(result.deferred_count).toBe(2);
  });

  it('creates backlog work without a current item for maintenance probes', async () => {
    mockListBacklog.mockResolvedValue({
      backlog: { current_phase_id: 'implementation', items: [] },
    });

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      signal: signal([missingRoute()]),
    });

    expect(mockResolveRequirementScopePolicy).toHaveBeenCalledWith(
      'requirement',
      null,
    );
    expect(mockUpsertBacklogItem).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it('extends an existing removal item when another source references the route', async () => {
    mockListBacklog.mockResolvedValue({
      backlog: {
        current_phase_id: 'implementation',
        items: [
          currentItem(),
          currentItem({
            id: 'remove-link-item',
            status: 'pending',
            touches: ['src/components/Header.tsx'],
            acceptance: [
              'src/components/Header.tsx no longer presents an interactive link or control targeting /pricing.',
            ],
            assumptions: [
              '[interaction-route:/pricing]',
              '[interaction-resolution:remove]',
            ],
          }),
        ],
      },
    });

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([
        missingRoute('/pricing', 'src/components/Footer.tsx'),
      ]),
    });

    expect(mockUpsertBacklogItem).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({
        id: 'remove-link-item',
        touches: [
          'src/components/Header.tsx',
          'src/components/Footer.tsx',
        ],
      }),
    }));
    expect(result.findings[0].backlog_item_id).toBe('remove-link-item');
  });

  it('defers to a pending item whose acceptance already owns the route', async () => {
    mockListBacklog.mockResolvedValue({
      backlog: {
        current_phase_id: 'implementation',
        items: [
          currentItem(),
          currentItem({
            id: 'pricing-item',
            status: 'pending',
            acceptance: ['GET /pricing renders the pricing screen'],
          }),
        ],
      },
    });

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([missingRoute()]),
    });

    expect(mockUpsertBacklogItem).not.toHaveBeenCalled();
    expect(result.findings[0].backlog_item_id).toBe('pricing-item');
    expect(result.ok).toBe(true);
  });

  it('does not defer to a terminal backlog item that used to own the route', async () => {
    mockIsItemTerminal.mockReturnValue(true);
    mockListBacklog.mockResolvedValue({
      backlog: {
        current_phase_id: 'implementation',
        items: [{
          id: 'old-item',
          status: 'needs_review',
          touches: ['src/app/pricing/page.tsx'],
        }],
      },
    });

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([missingRoute()]),
    });

    expect(mockUpsertBacklogItem).toHaveBeenCalled();
    expect(result.findings[0].backlog_item_id).toBe('new-item');
  });

  it('keeps a missing route blocking when the current item owns that route', async () => {
    mockListBacklog.mockResolvedValue({
      backlog: {
        current_phase_id: 'implementation',
        items: [{
          id: 'current',
          status: 'in_progress',
          touches: ['src/app/pricing/page.tsx'],
        }],
      },
    });

    const result = await applyInteractionBacklogPolicy({
      requirementId: 'requirement',
      backlogItemId: 'current',
      signal: signal([missingRoute()]),
    });

    expect(result.ok).toBe(false);
    expect(mockUpsertBacklogItem).not.toHaveBeenCalled();
    expect(result.findings[0].disposition).toBe('create_backlog');
  });
});
