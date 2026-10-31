// Vendored from market-fit/app/purchases/procurement/domain/schemas.ts.
// Pure canonical domain implementation; no runtime sibling dependency.
import { z } from 'zod';
import {
  eventSchema, exceptionSchema, fallbackSchema, identifierSchema, idsSchema,
  minorAmountSchema, stagesSchema, timestampSchema, timingSchema, timeZoneSchema, urgentPresetSchema,
} from './config';

const scopeSchema = z.object({
  productIds: idsSchema.default([]), categoryIds: idsSchema.default([]),
  lineMatch: z.enum(['any', 'all']).default('any'),
  requesterIds: idsSchema.default([]), responsibleIds: idsSchema.default([]),
}).strict();

export const requirementSchema = z.object({
  id: identifierSchema, name: z.string().trim().min(1).max(200),
  kind: z.enum(['technical', 'document', 'certification']),
  classification: z.enum(['mandatory', 'scored']),
  milestone: z.enum(['participation', 'evaluation', 'award', 'order', 'receipt']),
  overridable: z.boolean(),
  productIds: idsSchema.default([]), categoryIds: idsSchema.default([]),
  credential: z.object({
    holder: z.enum(['person', 'organization']),
    validity: z.enum(['submission', 'award', 'contract_period']),
    acceptedEquivalentIds: idsSchema.default([]),
    // Review configures provisional assessment; acceptance authority belongs to approval stages.
    evidenceRequired: z.boolean(), review: z.enum(['human', 'ai_assisted']),
  }).strict().nullable().default(null),
}).strict().superRefine((value, ctx) => {
  if ((value.kind === 'certification') !== (value.credential !== null)) {
    ctx.addIssue({ code: 'custom', path: ['credential'], message: 'Only certification requirements must specify credential semantics' });
  }
});

const amountSchema = z.object({
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'between']),
  valueMinor: minorAmountSchema, maxMinor: minorAmountSchema.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use an uppercase three-letter currency code'),
  basis: z.enum(['document', 'matching_lines']),
}).strict().superRefine((amount, ctx) => {
  if (amount.operator === 'between' && (amount.maxMinor === undefined || amount.maxMinor < amount.valueMinor)) {
    ctx.addIssue({ code: 'custom', path: ['maxMinor'], message: 'An inclusive range requires an upper bound at least equal to its lower bound' });
  } else if (amount.operator !== 'between' && amount.maxMinor !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['maxMinor'], message: 'Upper bounds are only allowed for ranges' });
  }
});

export const procurementRuleSchema = z.object({
  id: identifierSchema, version: z.number().int().min(1).default(1),
  name: z.string().trim().min(1).max(160), description: z.string().max(2000).default(''),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  type: z.enum(['approval', 'requirements', 'supplier_participation']), event: eventSchema,
  scope: scopeSchema.default({}), amount: amountSchema.nullable().default(null),
  effectiveFrom: timestampSchema.nullable().default(null), effectiveUntil: timestampSchema.nullable().default(null),
  stages: stagesSchema.default([]), requirements: z.array(requirementSchema).max(200).default([]),
  minimumSupplierProposals: z.number().int().min(1).max(1000).nullable().default(null),
}).strict().superRefine((rule, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (rule.effectiveFrom && rule.effectiveUntil && Date.parse(rule.effectiveUntil) <= Date.parse(rule.effectiveFrom)) issue('effectiveUntil', 'Effective end must follow effective start');
  if (new Set(rule.requirements.map((item) => item.id)).size !== rule.requirements.length) issue('requirements', 'Requirement identifiers must be distinct within a rule');
  if (rule.status === 'active') {
    if (rule.type === 'approval' && !rule.stages.length) issue('stages', 'Active approval rules require stages');
    if (rule.type === 'requirements' && !rule.requirements.length) issue('requirements', 'Active requirement rules require outcomes');
    if (rule.type === 'supplier_participation' && rule.minimumSupplierProposals === null) issue('minimumSupplierProposals', 'Active supplier rules require a proposal count');
  }
});

export const procurementPolicySchema = z.object({
  timeZone: timeZoneSchema.default('UTC'),
  crossRuleCounting: z.enum(['shared', 'independent']).default('independent'),
  fallback: fallbackSchema.default({ mode: 'block' }),
  supervisorId: identifierSchema.nullable().default(null), substituteIds: idsSchema.default([]),
  visibility: z.enum(['private', 'unlisted', 'public']).default('private'),
  allowGlobalListing: z.boolean().default(false),
  participation: z.enum(['open', 'invitation_only', 'approved_suppliers']).default('invitation_only'),
  offerOpening: z.enum(['on_receipt', 'after_close']).default('after_close'),
  timings: z.object({
    tenderResponse: timingSchema.nullable().default(null), clarification: timingSchema.nullable().default(null),
    offerValidity: timingSchema.nullable().default(null), approval: timingSchema.nullable().default(null),
  }).strict().default({}),
  exceptions: z.array(exceptionSchema).max(5).default([]),
  urgentPreset: urgentPresetSchema.default({ enabled: false, responseTiming: null, notifyPreviousEligibleSuppliers: false, minimumSupplierProposals: 1, decisionMode: 'human', preserveMandatoryRequirements: true }),
  rejectionNotifications: z.object({
    notifyRequester: z.boolean().default(true), notifyParticipants: z.boolean().default(false),
    recipientIds: idsSchema.default([]),
  }).strict().default({}),
}).strict().superRefine((policy, ctx) => {
  if (policy.exceptions.some((exception) => exception.enabled) && !policy.supervisorId) {
    ctx.addIssue({ code: 'custom', path: ['supervisorId'], message: 'Enabled exceptions require an explicit supervisor' });
  }
  if (new Set(policy.exceptions.map((item) => item.kind)).size !== policy.exceptions.length) {
    ctx.addIssue({ code: 'custom', path: ['exceptions'], message: 'Exception kinds must be distinct' });
  }
});

export const policyDocumentSchema = z.object({
  version: z.literal(1), settings: procurementPolicySchema,
  rules: z.array(procurementRuleSchema).max(500),
}).strict().superRefine((document, ctx) => {
  if (new Set(document.rules.map((rule) => rule.id)).size !== document.rules.length) {
    ctx.addIssue({ code: 'custom', path: ['rules'], message: 'Rule identifiers must be distinct' });
  }
});

export type ProcurementPolicy = z.infer<typeof procurementPolicySchema>;
export type ProcurementRule = z.infer<typeof procurementRuleSchema>;
export type PolicyDocument = z.infer<typeof policyDocumentSchema>;
export type ProcurementRequirement = z.infer<typeof requirementSchema>;

/** Safe initial configuration is blocked, not an implicit approval exemption. */
export function defaultPolicyDocument(): PolicyDocument {
  return policyDocumentSchema.parse({ version: 1, settings: {}, rules: [] });
}