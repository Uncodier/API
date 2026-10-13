jest.mock('@vercel/sandbox', () => ({ Sandbox: {} }));
jest.mock('@/lib/database/supabase-client', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/services/requirement-backlog-mutation', () => ({ mutateBacklogAtomically: jest.fn() }));
jest.mock('@/lib/services/requirement-metadata-patch', () => ({ patchRequirementMetadataKeys: jest.fn() }));
import { writeEvidence } from '@/lib/services/requirement-ground-truth';
import { mutateBacklogAtomically } from '@/lib/services/requirement-backlog-mutation';

const research = { requirement_id: 'req', item_id: 'item', plan_id: 'plan', execution_generation: 2, sources: [], reports: [] };

describe('canonical research generation boundary', () => {
  it.each([1, 3, undefined])('rejects research outside current requirement generation %s', async generation => {
    const backlog = { items: [{ id: 'item', evidence: { marker: 'unchanged' } }] };
    (mutateBacklogAtomically as jest.Mock).mockImplementation(async (_id, mutate) => mutate({ backlog,
      requirement: { metadata: { requirement_execution_generation: generation } } }));
    await expect(writeEvidence({ requirementId: 'req', itemId: 'item', requireCanonicalPersistence: true,
      record: { research } })).rejects.toThrow('execution scope is stale or mismatched');
    expect(backlog.items[0].evidence).toEqual({ marker: 'unchanged' });
  });
  it('stores actual research only in matching requirement/item/generation', async () => {
    const backlog = { items: [{ id: 'item' }] };
    (mutateBacklogAtomically as jest.Mock).mockImplementation(async (_id, mutate) => {
      const result = mutate({ backlog, requirement: { metadata: { requirement_execution_generation: 2 } } });
      return result.result;
    });
    await expect(writeEvidence({ requirementId: 'req', itemId: 'item', requireCanonicalPersistence: true,
      record: { research } })).resolves.toMatchObject({ research });
    await expect(writeEvidence({ requirementId: 'other', itemId: 'item', requireCanonicalPersistence: true,
      record: { research } })).rejects.toThrow('execution scope');
  });
});