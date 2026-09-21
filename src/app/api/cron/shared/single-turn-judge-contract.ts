import { analyzeAcceptanceEntry } from '@/lib/services/requirement-acceptance';

function stepContractAcceptance(step: any): string[] {
  const explicitCriteria = [
    ...(Array.isArray(step.success_criteria) ? step.success_criteria : []),
    ...(Array.isArray(step.validation_rules) ? step.validation_rules : []),
  ].filter((value): value is string =>
    typeof value === 'string' && value.trim().length > 0,
  );
  const fallback = typeof step.expected_output === 'string' &&
    step.expected_output.trim().length > 0
    ? [step.expected_output]
    : [];
  const executableCriteria = explicitCriteria.filter(
    (criterion) => analyzeAcceptanceEntry(criterion).executable,
  );
  return Array.from(new Set(
    executableCriteria.length > 0 ? executableCriteria : fallback,
  ));
}

export function adjudicationContractAcceptance(params: {
  step: any;
  requireContractJudge: boolean;
  isLastStep: boolean;
}): string[] | undefined {
  if (!params.requireContractJudge || params.isLastStep) return undefined;
  const acceptance = stepContractAcceptance(params.step);
  return acceptance.length > 0 ? acceptance : undefined;
}
