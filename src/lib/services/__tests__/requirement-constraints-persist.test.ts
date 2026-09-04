import { describe, expect, it, jest } from '@jest/globals';

const writeBacklog = jest.fn(async () => undefined);
const update = jest.fn(() => ({ eq: jest.fn(async () => ({ error: null })) }));

jest.mock('@/lib/services/requirement-backlog-store', () => ({
  loadRequirement: jest.fn(async () => ({
    id: 'req-1',
    type: 'doc',
    metadata: {},
    backlog: {
      schema_version: 1,
      items: [{ id: 'i1', title: 'Research', constraints: [], acceptance: [], status: 'pending', kind: 'content', phase_id: 'p', attempts: 0, scope_level: 'full' }],
      current_phase_id: 'p',
      completion_ratio: 0,
      cycles_spent_total: 0,
    },
  })),
  toBacklog: jest.fn((_raw: unknown, phase: string) => ({
    schema_version: 1,
    items: [{ id: 'i1', title: 'Research', constraints: [], acceptance: [], status: 'pending', kind: 'content', phase_id: phase, attempts: 0, scope_level: 'full' }],
    current_phase_id: phase,
    completion_ratio: 0,
    cycles_spent_total: 0,
  })),
  writeBacklog,
}));

jest.mock('@/lib/database/supabase-client', () => ({
  supabaseAdmin: { from: () => ({ update }) },
}));

describe('persistExtractedConstraints', () => {
  it('stamps MUST NOT lines onto items that have no constraints', async () => {
    const { persistExtractedConstraints } = await import('@/lib/services/requirement-constraints-persist');
    const texts = await persistExtractedConstraints('req-1', 'MUST NOT include outbound tactics');
    expect(texts.some((t) => /outbound/i.test(t))).toBe(true);
    expect(writeBacklog).toHaveBeenCalled();
  });
});
