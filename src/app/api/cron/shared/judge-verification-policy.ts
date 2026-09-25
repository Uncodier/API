import type {
  JudgeFailureKind,
  JudgeResult,
} from './archetype-judge-result';

export const DEFAULT_JUDGE_VERIFICATION_ATTEMPTS = 3;

export function verificationToolName(
  failureKind: JudgeFailureKind | undefined,
):
  | 'judge_evidence_collector'
  | 'judge_acceptance_contract'
  | 'judge_capability_resolver'
  | null {
  if (failureKind === 'evidence_gap') return 'judge_evidence_collector';
  if (failureKind === 'contract_error') return 'judge_acceptance_contract';
  if (failureKind === 'capability_gap') return 'judge_capability_resolver';
  return null;
}

export function judgeVerificationAttemptLimit(
  configured = process.env.JUDGE_VERIFICATION_MAX_ATTEMPTS,
): number {
  const parsed = Number.parseInt(configured || '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_JUDGE_VERIFICATION_ATTEMPTS;
}

export function verificationAttemptCount(
  toolFailures: Record<string, number> | undefined,
  toolName: string,
): number {
  const count = Number(toolFailures?.[toolName] || 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function requiredAction(failureKind: JudgeFailureKind | undefined): string {
  if (failureKind === 'evidence_gap') {
    return [
      'Inspect any relevant repository file, test, route, and runtime receipt.',
      'If the implementation already satisfies the criterion, collect the exact missing proof.',
      'This evidence-collection turn is read-only: do not edit files, push, or deploy.',
      'If inspection reveals a real defect, report it as a product defect so the next product turn can repair it.',
      'Do not repeat an identical probe without producing new evidence.',
    ].join(' ');
  }
  if (failureKind === 'contract_error') {
    return [
      'Inspect the implementation and rewrite only the ambiguous acceptance contract',
      'into executable criteria with concrete routes, files, methods, statuses, or tests.',
      'Do not weaken the intended product behavior.',
    ].join(' ');
  }
  if (failureKind === 'capability_gap') {
    return [
      'Do not modify product code to compensate for a verifier limitation.',
      'Execute the structured environment repair once to restore the capability named in the evidence gap.',
      'If that concrete repair attempt cannot restore it, quarantine the item for review and continue with another independent item.',
    ].join(' ');
  }
  return [
    'Inspect the cited repository behavior, repair the actual product defect,',
    'run the relevant validation, and then request another Judge pass.',
  ].join(' ');
}

export function summarizeJudgeEvidenceGaps(
  judge: Pick<JudgeResult, 'acceptance_diagnostics'>,
): string {
  return (judge.acceptance_diagnostics || [])
    .flatMap((diagnostic) =>
      diagnostic.gaps.map((gap) => {
        const observed = gap.observed?.[0]
          ? ` observed=${gap.observed[0]}`
          : '';
        return `${gap.code}: required=${gap.required}${observed}`;
      }),
    )
    .slice(0, 3)
    .join('; ');
}

export function formatJudgeRepairFeedback(
  judge: Pick<
    JudgeResult,
    | 'verdict'
    | 'reason'
    | 'failure_kind'
    | 'matched_acceptance'
    | 'unmatched_acceptance'
    | 'acceptance_diagnostics'
  >,
): string {
  const matched = judge.matched_acceptance.length > 0
    ? judge.matched_acceptance.map((criterion) => `- ${criterion}`).join('\n')
    : '- None';
  const unmatched = judge.unmatched_acceptance.length > 0
    ? judge.unmatched_acceptance.map((criterion) => `- ${criterion}`).join('\n')
    : '- None';
  const diagnostics = (judge.acceptance_diagnostics || [])
    .filter((diagnostic) => diagnostic.status !== 'matched')
    .map((diagnostic) => ({
      criterion_id: diagnostic.criterion_id,
      criterion: diagnostic.criterion,
      status: diagnostic.status,
      gaps: diagnostic.gaps.map((gap) => ({
        code: gap.code,
        class: gap.class,
        required: gap.required,
        observed: gap.observed,
        suggested_action: gap.suggested_action,
      })),
    }));
  return [
    'JUDGE VERIFICATION FAILED',
    `Verdict: ${judge.verdict}`,
    `Failure kind: ${judge.failure_kind || 'product_defect'}`,
    `Reason: ${judge.reason}`,
    'Matched acceptance:',
    matched,
    'Unmatched acceptance:',
    unmatched,
    'Structured evidence gaps:',
    diagnostics.length > 0
      ? JSON.stringify(diagnostics, null, 2)
      : '[]',
    `Required next action: ${requiredAction(judge.failure_kind)}`,
  ].join('\n').slice(0, 8_000);
}
