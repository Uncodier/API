import type {
  BacklogItem,
} from '@/lib/services/requirement-backlog-types';
import {
  resolveAcceptanceContract,
  validateAcceptanceContract,
} from '@/lib/services/requirement-acceptance-contract';

export function acceptanceValidation(item: BacklogItem) {
  return validateAcceptanceContract(resolveAcceptanceContract(
    item.acceptance || [],
    item.acceptance_contract,
  ));
}

export function requiresSuccessfulTestEvidence(
  item: BacklogItem,
): boolean {
  if (item.kind === 'api' || item.kind === 'crud') return true;
  const acceptanceContract = resolveAcceptanceContract(
    item.acceptance || [],
    item.acceptance_contract,
  );
  if (acceptanceContract.criteria.some((criterion) =>
    criterion.all_of.some((claim) =>
      claim.kind === 'command' ||
      (claim.kind === 'http_response' && claim.method !== 'GET'),
    ),
  )) {
    return true;
  }
  const contract = `${item.title} ${(item.acceptance || []).join(' ')}`;
  return (
    /\b(?:jest|vitest|unit test|integration test|test suite)\b/i.test(
      contract,
    ) ||
    /\b(?:POST|PUT|PATCH|DELETE)\s+\/api\//i.test(contract)
  );
}
