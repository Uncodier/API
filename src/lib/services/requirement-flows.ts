/**
 * Flow Registry — maps `requirements.type` to a declarative workflow definition
 * (phases, backlog item kinds, gate strategy, critic/judge skills, cost
 * envelope). The runtime reads this registry to decide what to do next without
 * hardcoding per-type branches in the orchestrator.
 *
 * Adding a new flow type: append to `RequirementKind`, add a `FlowDefinition`
 * to `FLOWS`, declare the judge/critic skills. Do not branch on `type` in
 * code — query the flow.
 */

import type { BacklogItemKind, BacklogItemStatus, RequirementBacklog } from './requirement-backlog-types';

export type RequirementKind =
  | 'app'
  | 'site'
  | 'doc'
  | 'presentation'
  | 'contract'
  | 'automation'
  | 'task'
  | 'makinari';

export interface FlowPhase {
  id: string;
  title: string;
  artifacts_expected: string[];
  completion_probe: string;
  wip_limit: number;
}

export interface CostEnvelope {
  max_cycles_per_item: number;
  max_turns_per_step: number;
  max_cycles_per_requirement: number;
}

/**
 * Vitrina (showcase) descriptor — a companion template repo that renders a
 * deliverable so the harness can run build+runtime probes on it. Example:
 * `doc` deliverables (MDX) would be previewed inside a docs viewer template
 * (`uncodie/vitrina-docs`) so the light gate can be augmented with a real
 * Vercel deploy. When absent, the flow ships the raw artefacts with only a
 * lightweight structural / syntax gate.
 */
export interface FlowShowcase {
  /**
   * `inline`          — no companion repo, the light gate is enough.
   * `vitrina-build-runtime` — clone the template, pipe artefacts in, run
   * build + runtime probes on the composite and fold the result into the
   * light signals. The dispatcher owns this wrapping so individual gates
   * stay small.
   */
  mode: 'inline' | 'vitrina-build-runtime';
  /** GitHub "<org>/<repo>" slug of the showcase template repo. */
  templateRepo?: string;
  /** Category of viewer the template implements (used for audit logs + UI). */
  viewerKind?: 'docs' | 'slides' | 'contract' | 'automation-dashboard';
}

export interface FlowDefinition {
  kind: RequirementKind;
  phases: FlowPhase[];
  backlog_kinds: BacklogItemKind[];
  gate_strategy: 'app' | 'doc' | 'slides' | 'contract' | 'backend' | 'task';
  judge_skill: string;
  critic_skill: string;
  standard_library?: { name: string; bootstrap_skill: string };
  /** Optional companion repo that renders the deliverable (see FlowShowcase). */
  showcase?: FlowShowcase;
  completion_detector: string;
  cost_envelope: CostEnvelope;
}

const DEFAULT_ENVELOPE: CostEnvelope = {
  max_cycles_per_item: 5,
  max_turns_per_step: 10,
  max_cycles_per_requirement: 30,
};

function appPhases(): FlowPhase[] {
  return [
    { id: 'base', title: 'Project base', artifacts_expected: ['package.json'], completion_probe: 'makinari-obj-template-selection', wip_limit: 1 },
    { id: 'investigate', title: 'Investigate', artifacts_expected: ['requirement.spec.md'], completion_probe: 'makinari-fase-investigacion', wip_limit: 1 },
    { id: 'build', title: 'Build', artifacts_expected: ['src/app/**/*.tsx', 'src/components/**'], completion_probe: 'makinari-rol-frontend', wip_limit: 1 },
    { id: 'qa', title: 'QA', artifacts_expected: ['.qa/scenarios/*.json', 'qa_results.json'], completion_probe: 'makinari-rol-qa', wip_limit: 1 },
    { id: 'validate', title: 'Validate', artifacts_expected: ['test_results.json'], completion_probe: 'makinari-fase-validacion', wip_limit: 1 },
    { id: 'report', title: 'Report', artifacts_expected: ['requirement_status'], completion_probe: 'makinari-fase-reporteado', wip_limit: 1 },
  ];
}

function docPhases(): FlowPhase[] {
  return [
    { id: 'outline', title: 'Outline', artifacts_expected: ['outline.md'], completion_probe: 'requirement-author', wip_limit: 1 },
    { id: 'draft', title: 'Draft sections', artifacts_expected: ['src/content/**/*.mdx'], completion_probe: 'makinari-rol-content', wip_limit: 1 },
    { id: 'review', title: 'Review', artifacts_expected: ['review_results.json'], completion_probe: 'makinari-rol-qa', wip_limit: 1 },
    { id: 'report', title: 'Report', artifacts_expected: ['requirement_status'], completion_probe: 'makinari-fase-reporteado', wip_limit: 1 },
  ];
}

function slidePhases(): FlowPhase[] {
  return [
    { id: 'outline', title: 'Outline', artifacts_expected: ['deck.outline.md'], completion_probe: 'requirement-author', wip_limit: 1 },
    { id: 'compose', title: 'Compose slides', artifacts_expected: ['slides/**/*.mdx'], completion_probe: 'makinari-rol-content', wip_limit: 1 },
    { id: 'visuals', title: 'Visuals', artifacts_expected: ['assets/**/*.png', 'assets/**/*.svg'], completion_probe: 'pitch-deck-visuals', wip_limit: 1 },
    { id: 'validate', title: 'Validate', artifacts_expected: ['deck_results.json'], completion_probe: 'makinari-fase-validacion', wip_limit: 1 },
    { id: 'report', title: 'Report', artifacts_expected: ['requirement_status'], completion_probe: 'makinari-fase-reporteado', wip_limit: 1 },
  ];
}

function contractPhases(): FlowPhase[] {
  return [
    { id: 'clauses', title: 'Draft clauses', artifacts_expected: ['contract/clauses/*.mdx'], completion_probe: 'makinari-rol-content', wip_limit: 1 },
    { id: 'schedule', title: 'Schedule', artifacts_expected: ['contract/schedule.mdx'], completion_probe: 'makinari-rol-content', wip_limit: 1 },
    { id: 'review', title: 'Legal review', artifacts_expected: ['review_results.json'], completion_probe: 'makinari-rol-qa', wip_limit: 1 },
    { id: 'report', title: 'Report', artifacts_expected: ['requirement_status'], completion_probe: 'makinari-fase-reporteado', wip_limit: 1 },
  ];
}

function automationPhases(): FlowPhase[] {
  return [
    { id: 'design', title: 'Design automation', artifacts_expected: ['src/app/api/**/route.ts'], completion_probe: 'makinari-obj-automatizacion', wip_limit: 1 },
    { id: 'build', title: 'Build', artifacts_expected: ['src/app/api/**/route.ts'], completion_probe: 'makinari-rol-backend', wip_limit: 1 },
    { id: 'validate', title: 'Validate', artifacts_expected: ['test_results.json'], completion_probe: 'makinari-fase-validacion', wip_limit: 1 },
    { id: 'report', title: 'Report', artifacts_expected: ['requirement_status'], completion_probe: 'makinari-fase-reporteado', wip_limit: 1 },
  ];
}

function taskPhases(): FlowPhase[] {
  return [
    { id: 'execute', title: 'Execute', artifacts_expected: ['artifact/**'], completion_probe: 'makinari-obj-tarea', wip_limit: 1 },
    { id: 'report', title: 'Report', artifacts_expected: ['requirement_status'], completion_probe: 'makinari-fase-reporteado', wip_limit: 1 },
  ];
}

export const FLOWS: Record<RequirementKind, FlowDefinition> = {
  app: {
    kind: 'app',
    phases: appPhases(),
    backlog_kinds: ['page', 'component', 'crud', 'api', 'auth', 'integration', 'polish'],
    gate_strategy: 'app',
    judge_skill: 'makinari-rol-judge-app',
    critic_skill: 'makinari-rol-critic',
    standard_library: { name: 'shadcn', bootstrap_skill: 'makinari-obj-template-selection' },
    completion_detector: 'phase:report',
    cost_envelope: DEFAULT_ENVELOPE,
  },
  site: {
    kind: 'site',
    phases: appPhases(),
    backlog_kinds: ['page', 'component', 'content', 'integration', 'polish'],
    gate_strategy: 'app',
    judge_skill: 'makinari-rol-judge-app',
    critic_skill: 'makinari-rol-critic',
    standard_library: { name: 'shadcn', bootstrap_skill: 'makinari-obj-template-selection' },
    completion_detector: 'phase:report',
    cost_envelope: DEFAULT_ENVELOPE,
  },
  doc: {
    kind: 'doc',
    phases: docPhases(),
    backlog_kinds: ['section', 'chapter', 'glossary', 'content'],
    gate_strategy: 'doc',
    judge_skill: 'makinari-rol-judge-doc',
    critic_skill: 'makinari-rol-critic',
    standard_library: { name: 'mdx-remark', bootstrap_skill: 'makinari-obj-template-selection' },
    completion_detector: 'phase:report',
    cost_envelope: DEFAULT_ENVELOPE,
  },
  presentation: {
    kind: 'presentation',
    phases: slidePhases(),
    backlog_kinds: ['slide', 'chart', 'asset', 'content'],
    gate_strategy: 'slides',
    judge_skill: 'makinari-rol-judge-slides',
    critic_skill: 'makinari-rol-critic',
    standard_library: { name: 'reveal', bootstrap_skill: 'makinari-obj-template-selection' },
    completion_detector: 'phase:report',
    cost_envelope: DEFAULT_ENVELOPE,
  },
  contract: {
    kind: 'contract',
    phases: contractPhases(),
    backlog_kinds: ['clause', 'schedule', 'annex', 'content'],
    gate_strategy: 'contract',
    judge_skill: 'makinari-rol-judge-contract',
    critic_skill: 'makinari-rol-critic',
    standard_library: { name: 'mdx-remark', bootstrap_skill: 'makinari-obj-template-selection' },
    completion_detector: 'phase:report',
    cost_envelope: DEFAULT_ENVELOPE,
  },
  automation: {
    kind: 'automation',
    phases: automationPhases(),
    backlog_kinds: ['api', 'subtask', 'script', 'integration'],
    gate_strategy: 'backend',
    judge_skill: 'makinari-rol-judge-backend',
    critic_skill: 'makinari-rol-critic',
    completion_detector: 'phase:report',
    cost_envelope: DEFAULT_ENVELOPE,
  },
  task: {
    kind: 'task',
    phases: taskPhases(),
    backlog_kinds: ['subtask', 'script'],
    gate_strategy: 'task',
    judge_skill: 'makinari-rol-judge-task',
    critic_skill: 'makinari-rol-critic',
    completion_detector: 'phase:report',
    cost_envelope: DEFAULT_ENVELOPE,
  },
  makinari: {
    kind: 'makinari',
    phases: taskPhases(),
    backlog_kinds: ['subtask', 'script', 'content'],
    gate_strategy: 'task',
    judge_skill: 'makinari-rol-judge-task',
    critic_skill: 'makinari-rol-critic',
    completion_detector: 'phase:report',
    cost_envelope: DEFAULT_ENVELOPE,
  },
};

/**
 * Best-effort classification of a legacy `requirements.type` value into the
 * canonical `RequirementKind`. Unknown types fall back to `app` — the most
 * common case in the current DB — and the caller can override.
 */
export function classifyRequirementType(raw: string | null | undefined): RequirementKind {
  if (!raw) return 'app';
  const t = raw.trim().toLowerCase();
  if (t === 'app' || t === 'site' || t === 'doc' || t === 'presentation' || t === 'contract' || t === 'automation' || t === 'task' || t === 'makinari') {
    return t;
  }
  if (t === 'develop' || t === 'design' || t.includes('app')) return 'app';
  if (t === 'landing' || t === 'website' || t.includes('site')) return 'site';
  if (t === 'content' || t.includes('blog') || t.includes('doc')) return 'doc';
  if (t.includes('deck') || t.includes('slide') || t.includes('present')) return 'presentation';
  if (t.includes('contract') || t.includes('legal')) return 'contract';
  if (t === 'integration' || t.includes('automat')) return 'automation';
  if (t === 'task' || t === 'planning') return 'task';
  return 'makinari';
}

export function getFlow(kind: RequirementKind): FlowDefinition {
  return FLOWS[kind];
}

/** Statuses that do not block a phase from advancing to the next one. */
const PHASE_TERMINAL_STATUSES: ReadonlySet<BacklogItemStatus> = new Set<BacklogItemStatus>([
  'done',
  'rejected',
  'needs_review',
]);

/**
 * Pure helper used by the backlog mutators to piggy-back a phase advance on
 * the same DB write they already do for an item status change. Returns the
 * target phase and the updated backlog when advancing is safe, otherwise
 * `null`. No IO.
 */
export function advancePhaseIfReadyInMemory(
  backlog: RequirementBacklog,
  flow: FlowDefinition,
): { to: FlowPhase; nextBacklog: RequirementBacklog } | null {
  const phaseId = backlog.current_phase_id || flow.phases[0]?.id;
  if (!phaseId) return null;
  const inPhase = backlog.items.filter((i) => i.phase_id === phaseId);
  if (inPhase.length === 0) return null; // never auto-advance an unseeded phase
  const blocking = inPhase.filter((i) => !PHASE_TERMINAL_STATUSES.has(i.status));
  if (blocking.length > 0) return null;
  const idx = flow.phases.findIndex((p) => p.id === phaseId);
  if (idx < 0 || idx >= flow.phases.length - 1) return null;
  const to = flow.phases[idx + 1];
  return { to, nextBacklog: { ...backlog, current_phase_id: to.id } };
}
