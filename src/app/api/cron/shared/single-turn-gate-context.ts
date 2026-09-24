import { getBacklogItem } from '@/lib/services/requirement-backlog';
import type {
  AcceptanceContract,
} from '@/lib/services/requirement-acceptance-contract';
import type {
  EvidenceRecord,
} from '@/lib/services/requirement-evidence-types';

export interface BacklogGateContext {
  acceptance?: string[];
  acceptanceContract?: AcceptanceContract;
  evidence?: EvidenceRecord;
}

export async function loadBacklogGateContext(
  requirementId: string,
  backlogItemId?: string | null,
): Promise<BacklogGateContext> {
  if (!backlogItemId) return {};
  try {
    const { item } = await getBacklogItem(
      requirementId,
      backlogItemId,
    );
    return {
      acceptance: item?.acceptance,
      acceptanceContract: item?.acceptance_contract,
      evidence: item?.evidence,
    };
  } catch (error: unknown) {
    console.warn(
      '[SingleTurn] Could not load backlog acceptance for runtime probes:',
      error instanceof Error ? error.message : error,
    );
    return {};
  }
}
