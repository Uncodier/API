import { describe, expect, it, jest } from '@jest/globals';

const mutateBacklogAtomically = jest.fn(
  async (_requirementId: string, mutate: (context: any) => any) => {
    const outcome = await mutate({
      requirement: {
        id: 'req-1',
        type: 'doc',
        metadata: {},
        backlog_revision: 0,
      },
      backlog: {
        schema_version: 1,
        items: [{
          id: 'i1',
          title: 'Research',
          constraints: [],
          acceptance: [],
          status: 'pending',
          kind: 'content',
          phase_id: 'p',
          attempts: 0,
          scope_level: 'full',
        }],
        current_phase_id: 'p',
        completion_ratio: 0,
        cycles_spent_total: 0,
      },
      flow: { phases: [{ id: 'p' }] },
    });
    return outcome.result;
  },
);
const patchRequirementMetadataKeys = jest.fn();

jest.mock('@/lib/services/requirement-backlog-mutation', () => ({
  mutateBacklogAtomically,
}));

jest.mock('@/lib/services/requirement-metadata-patch', () => ({
  patchRequirementMetadataKeys,
}));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: {},
}));

describe('persistExtractedConstraints', () => {
  it('stamps MUST NOT lines onto items that have no constraints', async () => {
    const { persistExtractedConstraints } = await import('@/lib/services/requirement-constraints-persist');
    const texts = await persistExtractedConstraints('req-1', 'MUST NOT include outbound tactics');
    expect(texts.some((t) => /outbound/i.test(t))).toBe(true);
    expect(mutateBacklogAtomically).toHaveBeenCalled();
    expect(patchRequirementMetadataKeys).toHaveBeenCalledWith({
      requirementId: 'req-1',
      patch: { extracted_constraints: texts },
    });
  });
});
