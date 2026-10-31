// Trusted MCP orchestration adapted from market-fit/app/api/procurement/
// requests/[id]/submit, tenders/[id]/publish and commerce/approvals routes.
// The bridge binds tenant/actor, verifies targets and persists pinned plans.
import { z } from 'zod';
import { identifierSchema, idsSchema, minorAmountSchema, timestampSchema } from './policy/config';
import { policyDocumentSchema } from './policy/schemas';
import { evaluateProcurementPolicy } from './policy/evaluate';
import { inheritedPolicySchema, inheritRequestPolicy } from './policy/inherited-policy';

const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const submitSchema = z.object({ id: uuid, expected_revision: versionSchema }).strict();
const publishSchema = z.object({ id: uuid, expected_version: versionSchema }).strict();
const approvalSchema = z.object({ target_id: uuid, expected_version: versionSchema, event: z.enum(['award', 'order']) }).strict();
const contextSchema = z.object({
  policy: z.object({ revision: versionSchema, document: z.unknown() }),
  target_id: uuid, target_version: versionSchema,
  actor_id: uuid, requester_id: uuid,
  evaluated_at: timestampSchema,
  currency: z.string().regex(/^[A-Z]{3}$/), net_amount_minor: minorAmountSchema,
  lines: z.array(z.object({
    id: identifierSchema,
    // Free-text tender/quotation lines have no product. Unlike the frontend's
    // commerce context schema, do not reject them for awards. Orders still do.
    productId: uuid.nullable(), categoryIds: idsSchema, netAmountMinor: minorAmountSchema,
  }).strict()).min(1).max(1000),
});
const downstreamSchema = contextSchema.merge(inheritedPolicySchema).extend({
  supplier_proposals: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/**
 * No model-supplied plan, policy, actor, override or evaluation inputs are accepted.
 * Context RPCs and policy.references must be host-bound, authenticated bridge calls.
 * This returns a plan for persistence, never authorization or a successful transition.
 */
export async function prepareProcurementApproval(
  operation: string,
  args: Record<string, unknown>,
  rpc: (operation: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const schema = operation === 'requests.submit' ? submitSchema
    : operation === 'tenders.publish' ? publishSchema
    : operation === 'approvals.create' ? approvalSchema : null;
  if (!schema) throw new Error('Unsupported procurement approval operation.');
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new Error('A valid procurement target and pinned version are required.');
  const event = operation === 'requests.submit' ? 'requisition'
    : operation === 'tenders.publish' ? 'publication' : (parsed.data as z.infer<typeof approvalSchema>).event;
  const input = parsed.data;
  const targetId = 'target_id' in input ? input.target_id : input.id;
  const targetVersion = 'expected_revision' in input ? input.expected_revision : input.expected_version;
  let raw: unknown;
  try { raw = await rpc(`context.${event}`, input); }
  catch { throw new Error('The procurement approval target could not be verified.'); }
  const context = (event === 'requisition' ? contextSchema : downstreamSchema).safeParse(raw);
  if (!context.success || context.data.target_id !== targetId || context.data.target_version !== targetVersion) {
    throw new Error('The procurement target changed or could not be verified.');
  }
  const data = context.data;
  const policy = policyDocumentSchema.safeParse(data.policy.document);
  if (!policy.success) throw new Error('A valid saved procurement policy is required.');
  let references: unknown;
  try { references = await rpc('policy.references', { policy_revision: data.policy.revision }); }
  catch { throw new Error('Procurement policy references could not be verified.'); }
  if (!z.object({ valid: z.literal(true) }).safeParse(references).success) {
    throw new Error('Procurement policy references are no longer eligible.');
  }
  // Event routes use the authenticated caller for commerce/publication scope;
  // requisitions use the saved requester's identity, never caller input.
  const requesterId = event === 'requisition' ? data.requester_id : data.actor_id;
  if (event === 'order' && data.lines.some(line => line.productId === null)) {
    throw new Error('Free-text lines are not supported for procurement orders.');
  }
  const now = data.evaluated_at;
  let plan = evaluateProcurementPolicy(policy.data, {
    event, currency: data.currency, netAmountMinor: data.net_amount_minor,
    requesterId, evaluatedAt: now, stageActivatedAt: now,
    ...(event === 'publication' ? { publicationAt: now } : {}),
    lines: data.lines,
  });
  if (event !== 'requisition') {
    const inherited = downstreamSchema.parse(raw);
    if (event === 'publication') {
      // Publication bases cannot yet resolve inherited requirements. Inherited
      // supplier counts remain pinned for the later award/order gate, as canonical.
      if (inherited.inherited_requirements.length || plan.requirements.length || plan.minimumSupplierProposals !== null) {
        throw new Error('Publication supplier requirements must be resolved before release.');
      }
    } else {
      plan = inheritRequestPolicy(plan, inherited);
      if (plan.requirements.length || (plan.minimumSupplierProposals !== null && inherited.supplier_proposals < plan.minimumSupplierProposals)) {
        throw new Error('Procurement requirements or minimum supplier offers remain unresolved.');
      }
    }
  }
  if (plan.status !== 'ready') throw new Error('Procurement policy resolution blocked progression.');
  if (plan.stages.some(stage => stage.decisionMode === 'automatic_ai')) {
    throw new Error('Automatic AI procurement decisions are not supported.');
  }
  if (plan.stages.some(stage => stage.execution === 'sequential' &&
    (stage.deadline ?? policy.data.settings.timings.approval)?.kind === 'duration')) {
    throw new Error('Sequential relative approval deadlines require activation scheduling.');
  }
  // The committing bridge must recheck this revision and the target version
  // under its transaction lock; a context read alone is not a concurrency guard.
  // Preserve the exact database JSON (not Zod's defaulted/stripped projection).
  // The committing RPC compares it under locks; target revision alone does not
  // detect changes in live catalog categories or inherited policy context.
  return { ...input, policy_revision: data.policy.revision, plan, expected_context: raw };
}