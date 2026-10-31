// Vendored from market-fit/app/purchases/procurement/domain/config.ts.
// Pure canonical domain implementation; no runtime sibling dependency.
import { z } from 'zod';

export const identifierSchema = z.string().trim().min(1).max(200);
export const idsSchema = z.array(identifierSchema).max(200).refine(
  (ids) => new Set(ids).size === ids.length, 'Identifiers must be distinct',
);
export const timestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => Number.isFinite(Date.parse(value)), 'Use a valid timestamp and UTC offset',
);
export const timeZoneSchema = z.string().max(100).refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}, 'Use a valid IANA time zone');
export const minorAmountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const eventSchema = z.enum(['requisition', 'offer', 'publication', 'award', 'order']);

export const timingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('duration'), value: z.number().int().min(1).max(87600),
    unit: z.enum(['hours', 'days', 'weeks']),
    anchor: z.enum(['publication', 'stage_activation']),
    calendar: z.enum(['calendar', 'business']),
    businessCalendarId: identifierSchema.nullable().default(null),
    timeZone: timeZoneSchema,
  }).strict(),
  z.object({ kind: z.literal('fixed'), at: timestampSchema, timeZone: timeZoneSchema }).strict(),
]).superRefine((timing, ctx) => {
  if (timing.kind === 'duration' && timing.calendar === 'business' && !timing.businessCalendarId) {
    ctx.addIssue({ code: 'custom', message: 'Business durations require a business calendar', path: ['businessCalendarId'] });
  }
});

const quorumSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('first_response') }).strict(),
  z.object({ mode: z.literal('n_of_m'), count: z.number().int().min(1).max(200) }).strict(),
]);

export const approvalStageSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(160),
  decisionMode: z.enum(['human', 'ai_assisted', 'automatic_ai']),
  approverIds: idsSchema,
  mandatoryApproverIds: idsSchema.default([]),
  quorum: quorumSchema,
  rejectionBehavior: z.enum(['veto', 'failed_vote', 'return_for_correction']),
  execution: z.enum(['sequential', 'parallel']),
  allowSelfApproval: z.boolean(),
  delegatedAgentId: identifierSchema.nullable().default(null),
  deadline: timingSchema.nullable().default(null),
  timeoutAction: z.enum(['block', 'remind', 'escalate', 'expire']),
  escalationIds: idsSchema.default([]),
}).strict().superRefine((stage, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (stage.decisionMode === 'automatic_ai') {
    if (!stage.delegatedAgentId) issue('delegatedAgentId', 'Automatic AI requires explicit delegated agent authority');
    if (stage.approverIds.length || stage.mandatoryApproverIds.length) issue('approverIds', 'Use a separate human stage for human approvals');
    if (stage.quorum.mode !== 'first_response') issue('quorum', 'One agent cannot manufacture multiple votes');
  } else {
    if (!stage.approverIds.length) issue('approverIds', 'A human stage requires eligible approvers');
    if (stage.quorum.mode === 'n_of_m' && stage.quorum.count > stage.approverIds.length) issue('quorum', 'Quorum exceeds eligible approvers');
    if (stage.delegatedAgentId) issue('delegatedAgentId', 'Only automatic AI may hold delegated decision authority');
  }
  if (stage.mandatoryApproverIds.some((id) => !stage.approverIds.includes(id))) issue('mandatoryApproverIds', 'Mandatory humans must be eligible approvers');
  if (stage.timeoutAction === 'escalate' && !stage.escalationIds.length) issue('escalationIds', 'Escalation requires recipients');
});

export const stagesSchema = z.array(approvalStageSchema).max(50).refine(
  (stages) => new Set(stages.map((stage) => stage.id)).size === stages.length,
  'Stage identifiers must be distinct',
);
export const fallbackSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('block') }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('approval'), stages: stagesSchema.refine((stages) => stages.length > 0, 'Approval requires stages') }).strict(),
]);

export const exceptionSchema = z.object({
  kind: z.enum(['absent_approver', 'urgent_purchase', 'insufficient_offers', 'inadequate_price', 'inadequate_certifications']),
  enabled: z.boolean(),
  aiRecommendation: z.literal(true),
  decisionAuthority: z.literal('supervisor'),
  allowedActions: z.array(z.enum(['substitute', 'continue', 'extend', 'invite_suppliers', 'negotiate', 'request_evidence', 'accept_equivalent'])).min(1).max(7),
  justificationRequired: z.literal(true),
}).strict();

export const urgentPresetSchema = z.object({
  enabled: z.boolean(),
  responseTiming: timingSchema.nullable(),
  notifyPreviousEligibleSuppliers: z.boolean(),
  minimumSupplierProposals: z.number().int().min(1).max(1000),
  decisionMode: z.enum(['human', 'ai_assisted', 'automatic_ai']),
  preserveMandatoryRequirements: z.literal(true),
}).strict();

export type Timing = z.infer<typeof timingSchema>;
export type ApprovalStage = z.infer<typeof approvalStageSchema>;
export type Fallback = z.infer<typeof fallbackSchema>;