// Vendored from market-fit/app/purchases/procurement/domain/evaluate.ts.
// Pure canonical domain implementation; no runtime sibling dependency.
import { z } from 'zod';
import { eventSchema, fallbackSchema, identifierSchema, idsSchema, minorAmountSchema, timestampSchema } from './config';
import type { ApprovalStage, Timing } from './config';
import { policyDocumentSchema } from './schemas';
import type { ProcurementRequirement, ProcurementRule } from './schemas';

export const simulationInputSchema = z.object({
  event: eventSchema, currency: z.string().regex(/^[A-Z]{3}$/), netAmountMinor: minorAmountSchema,
  evaluatedAt: timestampSchema,
  lines: z.array(z.object({
    id: identifierSchema, productId: identifierSchema.nullable().optional(),
    categoryIds: idsSchema.default([]), netAmountMinor: minorAmountSchema,
  }).strict()).max(1000).default([]),
  requesterId: identifierSchema.optional(), responsibleId: identifierSchema.optional(),
  publicationAt: timestampSchema.optional(), stageActivatedAt: timestampSchema.optional(),
  override: z.object({ fallback: fallbackSchema.optional() }).strict().optional(),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.lines.map((line) => line.id)).size !== input.lines.length) {
    ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Line identifiers must be distinct' });
  }
  if (input.lines.length && input.lines.reduce((sum, line) => sum + line.netAmountMinor, 0) !== input.netAmountMinor) {
    ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Line net amounts must equal the document net total' });
  }
});

export type SimulationInput = z.infer<typeof simulationInputSchema>;
export type ResolvedStage = ApprovalStage & { sourceRuleId: string | null; sourceRuleVersion: number | null; resolvedDeadline: string | null };
export type ResolvedRequirement = ProcurementRequirement & { sourceRuleIds: string[]; sourceRuleVersions: number[] };
export interface SimulationResult {
  simulationOnly: true;
  authorized: false;
  status: 'ready' | 'blocked';
  source: 'rules' | 'document' | 'general';
  matchedRuleIds: string[];
  stages: ResolvedStage[];
  requirements: ResolvedRequirement[];
  minimumSupplierProposals: number | null;
  crossRuleCounting: 'shared' | 'independent';
  issues: string[];
  explanations: string[];
}

/** Durations are elapsed UTC hours; business calendars are intentionally not guessed. */
function resolveDeadline(timing: Timing | null, input: SimulationInput, issues: string[]): string | null {
  if (!timing) return null;
  if (timing.kind === 'fixed') return new Date(timing.at).toISOString();
  if (timing.calendar === 'business') {
    issues.push(`Business calendar ${timing.businessCalendarId} must be resolved by an authorized calendar service.`);
    return null;
  }
  const anchor = timing.anchor === 'publication' ? input.publicationAt : input.stageActivatedAt;
  if (!anchor) {
    issues.push(`Missing deadline anchor: ${timing.anchor}.`);
    return null;
  }
  const hours = timing.unit === 'hours' ? 1 : timing.unit === 'days' ? 24 : 168;
  const deadline = new Date(Date.parse(anchor) + timing.value * hours * 3600000);
  if (!Number.isFinite(deadline.getTime())) {
    issues.push('Deadline is outside the supported date range.');
    return null;
  }
  return deadline.toISOString();
}

function compareAmount(amount: NonNullable<ProcurementRule['amount']>, value: number): boolean {
  switch (amount.operator) {
    case 'gt': return value > amount.valueMinor;
    case 'gte': return value >= amount.valueMinor;
    case 'lt': return value < amount.valueMinor;
    case 'lte': return value <= amount.valueMinor;
    case 'eq': return value === amount.valueMinor;
    case 'between': return value >= amount.valueMinor && value <= amount.maxMinor!;
  }
}

function requirementSignature(requirement: ProcurementRequirement): string {
  // Identifier arrays represent sets, not ordered preferences. Do not mutate stored values.
  return JSON.stringify({
    id: requirement.id, name: requirement.name, kind: requirement.kind,
    classification: requirement.classification, milestone: requirement.milestone,
    overridable: requirement.overridable,
    productIds: [...requirement.productIds].sort(), categoryIds: [...requirement.categoryIds].sort(),
    credential: requirement.credential ? {
      ...requirement.credential,
      acceptedEquivalentIds: [...requirement.credential.acceptedEquivalentIds].sort(),
    } : null,
  });
}

function matches(rule: ProcurementRule, input: SimulationInput, result: SimulationResult): boolean {
  const now = Date.parse(input.evaluatedAt);
  if (rule.status !== 'active' || rule.event !== input.event ||
      (rule.effectiveFrom && now < Date.parse(rule.effectiveFrom)) ||
      (rule.effectiveUntil && now >= Date.parse(rule.effectiveUntil))) return false;
  const { scope } = rule;
  for (const [ids, actual, label] of [
    [scope.requesterIds, input.requesterId, 'requester'],
    [scope.responsibleIds, input.responsibleId, 'responsible person'],
  ] as const) {
    if (ids.length && !actual) { result.issues.push(`${rule.name}: missing ${label}.`); return false; }
    if (ids.length && !ids.includes(actual!)) return false;
  }
  const scoped = scope.productIds.length > 0 || scope.categoryIds.length > 0;
  if ((scoped || rule.amount?.basis === 'matching_lines') && !input.lines.length) {
    result.issues.push(`${rule.name}: line inputs are required to evaluate scope.`);
    return false;
  }
  // Product and category dimensions intersect; IDs within each dimension are alternatives.
  const matchingLines = input.lines.filter((line) =>
    (!scope.productIds.length || (!!line.productId && scope.productIds.includes(line.productId))) &&
    (!scope.categoryIds.length || line.categoryIds.some((id) => scope.categoryIds.includes(id))),
  );
  if (scoped) {
    const missingClassification = input.lines.some((line) =>
      (scope.productIds.length > 0 && !line.productId) ||
      (scope.categoryIds.length > 0 && !line.categoryIds.length),
    );
    if (missingClassification) {
      result.issues.push(`${rule.name}: product/category classification is missing for a required scope.`);
      return false;
    }
    if (!matchingLines.length || (scope.lineMatch === 'all' && matchingLines.length !== input.lines.length)) return false;
  }
  if (rule.amount) {
    if (rule.amount.currency !== input.currency) {
      result.issues.push(`${rule.name}: no authorized dated FX conversion from ${input.currency} to ${rule.amount.currency}.`);
      return false;
    }
    const value = rule.amount.basis === 'document' ? input.netAmountMinor : matchingLines.reduce((sum, line) => sum + line.netAmountMinor, 0);
    result.explanations.push(`${rule.name}: compared ${value} ${input.currency} net minor units (${rule.amount.basis}).`);
    if (!compareAmount(rule.amount, value)) return false;
  }
  return true;
}

/** Pure policy planning only. This never casts votes, runs AI, or authorizes a transition. */
export function evaluateProcurementPolicy(documentValue: unknown, inputValue: unknown): SimulationResult {
  const result: SimulationResult = {
    simulationOnly: true, authorized: false, status: 'blocked', source: 'general', matchedRuleIds: [],
    stages: [], requirements: [], minimumSupplierProposals: null, crossRuleCounting: 'independent',
    issues: [], explanations: ['Simulation only: no approvals, AI decisions, or downstream operations are executed.'],
  };
  const documentResult = policyDocumentSchema.safeParse(documentValue);
  const inputResult = simulationInputSchema.safeParse(inputValue);
  if (!documentResult.success || !inputResult.success) {
    for (const parsed of [documentResult, inputResult]) {
      if (!parsed.success) result.issues.push(...parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
    }
    return result;
  }
  const document = documentResult.data;
  const input = inputResult.data;
  result.crossRuleCounting = document.settings.crossRuleCounting;
  const rules = [...document.rules].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .filter((rule) => matches(rule, input, result));
  const addStage = (stage: ApprovalStage, rule: ProcurementRule | null) => {
    const resolvedDeadline = resolveDeadline(stage.deadline ?? document.settings.timings.approval, input, result.issues);
    const resolvedStage = { ...stage, sourceRuleId: rule?.id ?? null, sourceRuleVersion: rule?.version ?? null, resolvedDeadline };
    result.stages.push(resolvedStage);
    if (!stage.allowSelfApproval && stage.decisionMode !== 'automatic_ai') {
      if (!input.requesterId) result.issues.push(`${stage.name}: requester is required to evaluate self-approval restrictions.`);
      else {
        const eligible = stage.approverIds.filter((id) => id !== input.requesterId);
        resolvedStage.approverIds = eligible;
        const count = stage.quorum.mode === 'n_of_m' ? stage.quorum.count : 1;
        if (eligible.length < count || stage.mandatoryApproverIds.includes(input.requesterId) || (stage.quorum.mode === 'all' && stage.approverIds.includes(input.requesterId))) {
          result.issues.push(`${stage.name}: self-approval restrictions make the configured quorum impossible.`);
        }
      }
    }
    if (resolvedDeadline && Date.parse(resolvedDeadline) <= Date.parse(input.evaluatedAt)) result.issues.push(`${stage.name}: deadline reached; timeout action is ${stage.timeoutAction}, never approval.`);
    if (stage.decisionMode !== 'human') result.explanations.push(`${stage.name}: AI ${stage.decisionMode === 'automatic_ai' ? 'decision' : 'recommendation'} is not executed by this simulator.`);
  };
  if (rules.length) {
    result.source = 'rules';
    for (const rule of rules) {
      result.matchedRuleIds.push(rule.id);
      rule.stages.forEach((stage) => addStage(stage, rule));
      for (const requirement of rule.requirements) {
        const previous = result.requirements.find((entry) => entry.id === requirement.id);
        if (!previous) result.requirements.push({ ...requirement, sourceRuleIds: [rule.id], sourceRuleVersions: [rule.version] });
        else {
          if (requirementSignature(previous) !== requirementSignature(requirement)) result.issues.push(`Conflicting requirement ${requirement.id}; no rule may overwrite another requirement.`);
          previous.sourceRuleIds.push(rule.id);
          previous.sourceRuleVersions.push(rule.version);
        }
      }
      if (rule.minimumSupplierProposals !== null) result.minimumSupplierProposals = Math.max(result.minimumSupplierProposals ?? 0, rule.minimumSupplierProposals);
    }
  } else {
    const fallback = input.override?.fallback ?? document.settings.fallback;
    result.source = input.override?.fallback ? 'document' : 'general';
    result.explanations.push(`No rules matched; using ${result.source} fallback (${fallback.mode}).`);
    if (fallback.mode === 'block') result.issues.push('The effective fallback blocks progression until an explicit policy is configured.');
    if (fallback.mode === 'approval') fallback.stages.forEach((stage) => addStage(stage, null));
    if (fallback.mode === 'none') result.explanations.push('The configured fallback explicitly requires no approval; this is not transition authorization.');
  }
  result.status = result.issues.length ? 'blocked' : 'ready';
  return result;
}