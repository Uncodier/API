import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';
import { matchAcceptanceAgainstEvidence } from './archetype-acceptance-match';

export type JudgeVerdict = 'approved' | 'rejected' | 'escalate';
export type JudgeFailureKind =
  | 'product_defect'
  | 'evidence_gap'
  | 'contract_error';

export interface JudgeResult {
  verdict: JudgeVerdict;
  reason: string;
  matched_acceptance: string[];
  unmatched_acceptance: string[];
  failure_kind?: JudgeFailureKind;
}

function defaultUnmatched(item: BacklogItem): string[] {
  return item.acceptance ?? [];
}

export function rejectedJudgeResult(
  item: BacklogItem,
  reason: string,
  failureKind: JudgeFailureKind = 'product_defect',
): JudgeResult {
  return {
    verdict: 'rejected',
    reason,
    matched_acceptance: [],
    unmatched_acceptance: defaultUnmatched(item),
    failure_kind: failureKind,
  };
}

export function matchOrEscalateJudgeResult(
  item: BacklogItem,
  evidence: EvidenceRecord,
): JudgeResult {
  const { matched, unmatched, contradicted } =
    matchAcceptanceAgainstEvidence(
    item.acceptance ?? [],
    evidence,
  );
  if (contradicted.length > 0) {
    return {
      verdict: 'rejected',
      reason:
        `${contradicted.length} acceptance entr${contradicted.length === 1 ? 'y is' : 'ies are'} contradicted by hard-fail evidence: ` +
        contradicted.slice(0, 3).map((criterion) => `"${criterion}"`).join('; '),
      matched_acceptance: matched,
      unmatched_acceptance: [...contradicted, ...unmatched],
      failure_kind: 'product_defect',
    };
  }
  if (unmatched.length === 0) {
    return {
      verdict: 'approved',
      reason: 'all acceptance entries matched in evidence',
      matched_acceptance: matched,
      unmatched_acceptance: [],
    };
  }

  const totalAcceptance = item.acceptance?.length ?? 0;
  const sample = unmatched.slice(0, 3).map((criterion) => {
    const text = criterion.length > 120
      ? `${criterion.slice(0, 117)}...`
      : criterion;
    return `"${text}"`;
  });
  const detail = sample.length > 0
    ? ` Unmatched: ${sample.join('; ')}${unmatched.length > 3 ? ' (and more)' : ''}. Produce evidence (tool call / route / test) that proves those criteria.`
    : '';

  return {
    verdict: (item.attempts ?? 0) >= 3 ? 'escalate' : 'rejected',
    reason: (item.attempts ?? 0) >= 3
      ? `attempts=${item.attempts ?? 0} with ${unmatched.length}/${totalAcceptance} unmatched acceptance — requesting evidence remediation without charging another product attempt.${detail}`
      : `${unmatched.length}/${totalAcceptance} acceptance entries lack matching evidence.${detail}`,
    matched_acceptance: matched,
    unmatched_acceptance: unmatched,
    failure_kind: 'evidence_gap',
  };
}
