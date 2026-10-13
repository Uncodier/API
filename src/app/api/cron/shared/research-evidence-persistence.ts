import { getBacklogItem } from '@/lib/services/requirement-backlog';
import { writeEvidence } from '@/lib/services/requirement-ground-truth';
import { collectResearchEvidence } from './research-report-evidence';

/** Called after each real turn: a one-tool turn's search results otherwise disappear before completion. */
export async function persistResearchTurn(params: {
  requirementId: string; itemId: string; planId: string; stepId: string;
  executionGeneration: number; result: any;
  assertOwnership: () => Promise<void>;
}): Promise<boolean> {
  const { item } = await getBacklogItem(params.requirementId, params.itemId);
  if (!item) throw new Error('Research evidence backlog item is missing');
  const research = collectResearchEvidence({ ...params, previous: item.evidence?.research });
  if (!research || JSON.stringify(research) === JSON.stringify(item.evidence?.research)) return false;
  await params.assertOwnership();
  // Canonical storage only: report-only delivery must not create evidence files in a repo.
  await writeEvidence({ requirementId: params.requirementId, itemId: params.itemId,
    requireCanonicalPersistence: true, record: { research } });
  return true;
}