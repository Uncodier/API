export type PlanStepContractInput = {
  title?: string;
  description?: string;
  type?: string;
  role?: string | null;
  skill?: string | null;
  instructions?: string;
  expected_output?: string;
  success_criteria?: unknown[];
  validation_rules?: unknown[];
  test_command?: string | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

const INVESTIGATION_SKILL = 'makinari-fase-investigacion';
const RESEARCH_INTENT =
  /\b(?:investigat|research|inspect|analy[sz]|diagnos|audit)[a-z]*\b|\breview\s+current\b/i;

export const PLAN_ROLE_TO_SKILL: Record<string, string> = {
  template_selection: 'makinari-obj-template-selection',
  frontend: 'makinari-rol-frontend',
  backend: 'makinari-rol-backend',
  devops: 'makinari-rol-devops',
  content: 'makinari-rol-content',
  orchestrator: 'makinari-rol-orchestrator',
  qa: 'makinari-rol-qa',
  investigate: INVESTIGATION_SKILL,
  plan: 'makinari-fase-planeacion',
  validate: 'makinari-fase-validacion',
  report: 'makinari-fase-reporteado',
};

export function isResearchPlanStep(step: PlanStepContractInput): boolean {
  const type = String(step.type || '').toLowerCase();
  if (type === 'research') return true;
  const role = String(step.role || '').toLowerCase();
  const skill = String(step.skill || '').toLowerCase();
  if (role === 'investigate' || skill === INVESTIGATION_SKILL) return true;
  return RESEARCH_INTENT.test(
    `${step.title || ''} ${step.description || ''} ` +
      `${step.instructions || ''} ${step.expected_output || ''}`,
  );
}

export function hasExplicitBlockingResearchContract(
  step: PlanStepContractInput,
): boolean {
  const blockingUnknown = step.metadata?.blocking_unknown;
  return (
    typeof blockingUnknown === 'string' &&
    blockingUnknown.trim().length > 0 &&
    typeof step.expected_output === 'string' &&
    step.expected_output.trim().length > 0 &&
    Array.isArray(step.success_criteria) &&
    step.success_criteria.length > 0
  );
}

export function assertResearchStepAllowedForPhase(
  step: PlanStepContractInput,
  phaseId?: string | null,
  contractSource: PlanStepContractInput = step,
): void {
  if (isResearchPlanStep(step) && !phaseId) {
    throw new Error(
      `Research step "${step.title || 'Untitled research'}" must reference ` +
        'an existing backlog_item_id so its requirement phase can be verified.',
    );
  }
  if (
    phaseId === 'build' &&
    isResearchPlanStep(step) &&
    !hasExplicitBlockingResearchContract(contractSource)
  ) {
    throw new Error(
      `Standalone research step "${step.title || 'Untitled research'}" is not allowed for a build-phase backlog item. ` +
      'Use coordinator investigation before plan creation, fold repository inspection into the implementation step, ' +
      'or provide metadata.blocking_unknown plus explicit expected_output and success_criteria for a genuinely blocking unknown.',
    );
  }
}

export function assertKnownPlanStepSkill(
  step: PlanStepContractInput,
  skillExists: (skill: string) => boolean,
): void {
  if (
    step.skill &&
    step.skill !== 'general' &&
    !skillExists(step.skill)
  ) {
    throw new Error(
      `Step "${step.title || 'Untitled step'}" references unknown skill "${step.skill}".`,
    );
  }
}

export function assertCompatiblePlanStepAssignment(
  step: PlanStepContractInput,
): void {
  const canonicalSkill = step.role
    ? PLAN_ROLE_TO_SKILL[step.role.toLowerCase()]
    : undefined;
  if (
    step.skill &&
    canonicalSkill &&
    Object.values(PLAN_ROLE_TO_SKILL).includes(step.skill) &&
    step.skill !== canonicalSkill
  ) {
    throw new Error(
      `Step "${step.title || 'Untitled step'}" has incompatible role="${step.role}" and skill="${step.skill}". Expected "${canonicalSkill}" for that role.`,
    );
  }
}

export function normalizePlanStepContract<T extends PlanStepContractInput>(
  step: T,
): T & PlanStepContractInput {
  const research = isResearchPlanStep(step);
  const title = String(step.title || step.description || 'Plan step').trim();
  const normalized = { ...step } as T & PlanStepContractInput;

  if (research) {
    normalized.role = 'investigate';
    normalized.skill = INVESTIGATION_SKILL;
    if (!step.expected_output?.trim()) {
      normalized.expected_output =
        `A concise, evidence-backed diagnosis for "${title}" that states ` +
        'either the confirmed root cause or that the reported failure is not reproducible, ' +
        'plus the exact recommended next action.';
    }
    if (!step.success_criteria?.length) {
      normalized.success_criteria = [
        'Inspect only the files and runtime evidence needed to answer the stated question.',
        'Run each targeted diagnostic at most once unless its inputs changed.',
        'Report a confirmed root cause or explicitly conclude that the failure is not reproducible.',
      ];
    }
    if (!step.validation_rules?.length) {
      normalized.validation_rules = [
        'Passing checks are valid evidence; do not keep searching for a historical failure.',
        'Do not repeat an unchanged successful command or reread an unchanged file.',
        'Finish with instance_plan.execute_step after the diagnosis is reported.',
      ];
    }
    return normalized;
  }

  const canonicalSkill = step.role
    ? PLAN_ROLE_TO_SKILL[step.role.toLowerCase()]
    : undefined;
  if (!step.skill && canonicalSkill) {
    normalized.skill = canonicalSkill;
  }

  if (!step.expected_output?.trim()) {
    normalized.expected_output = `A completed and verified outcome for "${title}".`;
  }
  if (!step.success_criteria?.length) {
    normalized.success_criteria = [
      `The instructions for "${title}" are implemented.`,
      'The step output identifies the changed files and validation evidence.',
    ];
  }
  if (!step.validation_rules?.length) {
    normalized.validation_rules = step.test_command
      ? [`The command "${step.test_command}" exits successfully.`]
      : ['Run the narrowest relevant validation before requesting completion.'];
  }

  return normalized;
}
