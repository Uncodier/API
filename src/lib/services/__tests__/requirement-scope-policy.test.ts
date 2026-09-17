import type { BacklogItem } from '../requirement-backlog-types';
import { classifyRequirementScopePolicy } from '../requirement-scope-policy';

function item(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'item',
    title: 'Build page',
    kind: 'page',
    phase_id: 'build',
    acceptance: [],
    status: 'in_progress',
    attempts: 0,
    scope_level: 'full',
    ...overrides,
  };
}

describe('requirement scope policy', () => {
  it('allows expansion when no budget or strict contract exists', () => {
    expect(classifyRequirementScopePolicy(item())).toEqual({
      strict: false,
      reason: 'requirement allows backlog expansion',
    });
  });

  it.each(['mvp', 'minimal'] as const)(
    'treats %s item scope as strict',
    (scope_level) => {
      expect(
        classifyRequirementScopePolicy(item({ scope_level })),
      ).toEqual(expect.objectContaining({ strict: true }));
    },
  );

  it('does not treat ordinary route acceptance as closed scope', () => {
    expect(
      classifyRequirementScopePolicy(
        item({ acceptance: ['GET /contact renders the contact form'] }),
      ),
    ).toEqual({
      strict: false,
      reason: 'requirement allows backlog expansion',
    });
  });

  it('treats explicit scope constraints as strict', () => {
    expect(
      classifyRequirementScopePolicy(
        item({ constraints: ['Only implement the routes listed in scope'] }),
      ),
    ).toEqual({
      strict: true,
      reason: 'active backlog item declares strict scope constraints',
    });
  });

  it('does not treat an unrelated "only" constraint as closed scope', () => {
    expect(
      classifyRequirementScopePolicy(
        item({ constraints: ['Only use the approved blue color palette'] }),
      ),
    ).toEqual({
      strict: false,
      reason: 'requirement allows backlog expansion',
    });
  });

  it('does not treat a missing legacy scope value as strict', () => {
    expect(
      classifyRequirementScopePolicy(
        { ...item(), scope_level: undefined } as unknown as BacklogItem,
      ),
    ).toEqual({
      strict: false,
      reason: 'requirement allows backlog expansion',
    });
  });

  it('treats an explicit requirement budget as strict', () => {
    expect(
      classifyRequirementScopePolicy(item(), { budget: 500 }),
    ).toEqual({
      strict: true,
      reason: 'requirement has an explicit budget',
    });
  });

  it('honors structured scope-expansion metadata', () => {
    expect(
      classifyRequirementScopePolicy(item(), {
        metadata: { allow_scope_expansion: false },
      }),
    ).toEqual({
      strict: true,
      reason: 'requirement metadata disallows scope expansion',
    });
  });

  it('honors persisted strict scope constraints without an active item', () => {
    expect(
      classifyRequirementScopePolicy(null, {
        metadata: {
          extracted_constraints: ['Do not add routes outside the contract'],
        },
      }),
    ).toEqual({
      strict: true,
      reason: 'requirement metadata disallows scope expansion',
    });
  });
});
