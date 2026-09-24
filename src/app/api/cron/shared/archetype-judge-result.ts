import type { BacklogItem } from '@/lib/services/requirement-backlog-types';
import type { EvidenceRecord } from '@/lib/services/requirement-ground-truth';
import type {
  AcceptanceCriterionDiagnostic,
} from '@/lib/services/requirement-evidence-types';
import { matchAcceptanceAgainstEvidence } from './archetype-acceptance-match';

export type JudgeVerdict = 'approved' | 'rejected' | 'escalate';
export type JudgeFailureKind =
  | 'product_defect'
  | 'evidence_gap'
  | 'contract_error'
  | 'capability_gap';

export interface JudgeResult {
  verdict: JudgeVerdict;
  reason: string;
  matched_acceptance: string[];
  unmatched_acceptance: string[];
  acceptance_diagnostics?: AcceptanceCriterionDiagnostic[];
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
    acceptance_diagnostics: [],
    failure_kind: failureKind,
  };
}

function failureKindFromDiagnostics(
  diagnostics: AcceptanceCriterionDiagnostic[],
): JudgeFailureKind {
  const gapClasses = new Set(
    diagnostics.flatMap((diagnostic) =>
      diagnostic.gaps.map((gap) => gap.class)),
  );
  if (gapClasses.has('capability')) return 'capability_gap';
  if (gapClasses.has('contract')) return 'contract_error';
  if (gapClasses.has('product')) return 'product_defect';
  return 'evidence_gap';
}

export function matchOrEscalateJudgeResult(
  item: BacklogItem,
  evidence: EvidenceRecord,
): JudgeResult {
  const { matched, unmatched, contradicted, diagnostics } =
    matchAcceptanceAgainstEvidence(
    item.acceptance ?? [],
    evidence,
      item.acceptance_contract,
  );
  if (contradicted.length > 0) {
    return {
      verdict: 'rejected',
      reason:
        `${contradicted.length} acceptance entr${contradicted.length === 1 ? 'y is' : 'ies are'} contradicted by hard-fail evidence: ` +
        contradicted.slice(0, 3).map((criterion) => `"${criterion}"`).join('; '),
      matched_acceptance: matched,
      unmatched_acceptance: [...contradicted, ...unmatched],
      acceptance_diagnostics: diagnostics,
      failure_kind: 'product_defect',
    };
  }
  if (unmatched.length === 0) {
    return {
      verdict: 'approved',
      reason: 'all acceptance entries matched in evidence',
      matched_acceptance: matched,
      unmatched_acceptance: [],
      acceptance_diagnostics: diagnostics,
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
  const failureKind = failureKindFromDiagnostics(diagnostics);
  const shouldEscalate =
    failureKind === 'capability_gap' || (item.attempts ?? 0) >= 3;
  const remediation =
    failureKind === 'capability_gap'
      ? 'The current harness lacks a required verification capability; quarantine this item instead of changing product code.'
      : 'Produce the exact missing typed evidence without repeating an identical probe.';

  return {
    verdict: shouldEscalate ? 'escalate' : 'rejected',
    reason: shouldEscalate
      ? `attempts=${item.attempts ?? 0} with ${unmatched.length}/${totalAcceptance} unmatched acceptance. ${remediation}${detail}`
      : `${unmatched.length}/${totalAcceptance} acceptance entries lack matching evidence. ${remediation}${detail}`,
    matched_acceptance: matched,
    unmatched_acceptance: unmatched,
    acceptance_diagnostics: diagnostics,
    failure_kind: failureKind,
  };
}
