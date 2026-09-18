const mockLoadRequirement = jest.fn();
const mockToBacklog = jest.fn((value: unknown) => value);
const mockWriteBacklogCas = jest.fn();

class MockBacklogWriteConflictError extends Error {
  constructor() {
    super('conflict');
    this.name = 'BacklogWriteConflictError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

jest.mock('../requirement-backlog-store', () => ({
  BacklogWriteConflictError: MockBacklogWriteConflictError,
  loadRequirement: mockLoadRequirement,
  toBacklog: mockToBacklog,
  writeBacklogCas: mockWriteBacklogCas,
}));

jest.mock('../requirement-flows', () => ({
  classifyRequirementType: jest.fn(() => 'app'),
  getFlow: jest.fn(() => ({
    kind: 'app',
    phases: [{ id: 'build' }],
  })),
}));

import { mutateBacklogAtomically } from '../requirement-backlog-mutation';

function requirement(revision: number, itemIds: string[]) {
  return {
    id: 'req-1',
    type: 'app',
    metadata: {},
    backlog_revision: revision,
    backlog: {
      schema_version: 1,
      current_phase_id: 'build',
      completion_ratio: 0,
      cycles_spent_total: 0,
      items: itemIds.map((id) => ({ id })),
    },
  };
}

describe('mutateBacklogAtomically', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reloads and reapplies a mutation after a concurrent write', async () => {
    mockLoadRequirement
      .mockResolvedValueOnce(requirement(4, ['existing']))
      .mockResolvedValueOnce(requirement(5, ['existing', 'concurrent']));
    mockWriteBacklogCas
      .mockRejectedValueOnce(new MockBacklogWriteConflictError())
      .mockResolvedValueOnce(6);

    const result = await mutateBacklogAtomically('req-1', ({ backlog }) => {
      backlog.items.push({ id: 'ours' } as never);
      return {
        result: backlog.items.map((item) => item.id),
      };
    });

    expect(result).toEqual(['existing', 'concurrent', 'ours']);
    expect(mockWriteBacklogCas).toHaveBeenNthCalledWith(
      2,
      'req-1',
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ id: 'concurrent' }),
          expect.objectContaining({ id: 'ours' }),
        ]),
      }),
      5,
    );
  });

  it('can return a read-only result without writing', async () => {
    mockLoadRequirement.mockResolvedValueOnce(requirement(1, ['existing']));

    await expect(
      mutateBacklogAtomically('req-1', ({ backlog }) => ({
        result: backlog.items[0].id,
        write: false,
      })),
    ).resolves.toBe('existing');
    expect(mockWriteBacklogCas).not.toHaveBeenCalled();
  });

  it('preserves a concurrent user-message reopen while replaying an upsert', async () => {
    const beforeReset = requirement(7, ['review-item']);
    (beforeReset.backlog.items[0] as any).status = 'needs_review';
    const afterReset = requirement(8, ['review-item']);
    (afterReset.backlog.items[0] as any).status = 'pending';
    mockLoadRequirement
      .mockResolvedValueOnce(beforeReset)
      .mockResolvedValueOnce(afterReset);
    mockWriteBacklogCas
      .mockRejectedValueOnce(new MockBacklogWriteConflictError())
      .mockResolvedValueOnce(9);

    await mutateBacklogAtomically('req-1', ({ backlog }) => {
      backlog.items.push({ id: 'new-item', status: 'pending' } as never);
      return { result: undefined };
    });

    expect(mockWriteBacklogCas).toHaveBeenNthCalledWith(
      2,
      'req-1',
      expect.objectContaining({
        items: [
          expect.objectContaining({ id: 'review-item', status: 'pending' }),
          expect.objectContaining({ id: 'new-item', status: 'pending' }),
        ],
      }),
      8,
    );
  });
});
