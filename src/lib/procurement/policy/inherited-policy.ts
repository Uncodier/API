// Vendored from market-fit/app/api/procurement/policy/inherited-policy.ts.
// Only imports are adapted to the API-local pure domain implementation.
import { z } from 'zod'
import { requirementSchema } from './schemas'
import type { ResolvedRequirement, SimulationResult } from './evaluate'

const resolvedRequirementSchema = z.object({ sourceRuleIds: z.array(z.string()), sourceRuleVersions: z.array(z.number().int()) })
  .passthrough().superRefine((value, context) => {
    const requirement = Object.fromEntries(Object.entries(value).filter(([key]) => !['sourceRuleIds', 'sourceRuleVersions'].includes(key)))
    if (!requirementSchema.safeParse(requirement).success) context.addIssue({ code: 'custom', message: 'Invalid inherited requirement' })
  }).transform(value => value as ResolvedRequirement)

export const inheritedPolicySchema = z.object({
  inherited_requirements: z.array(resolvedRequirementSchema),
  minimum_supplier_proposals: z.number().int().nonnegative(),
})

/** The database pins requisition outcomes independently of today's event rules. */
export function inheritRequestPolicy(plan: SimulationResult, inherited: z.infer<typeof inheritedPolicySchema>): SimulationResult {
  return { ...plan, requirements: [...plan.requirements, ...inherited.inherited_requirements],
    minimumSupplierProposals: Math.max(plan.minimumSupplierProposals ?? 0, inherited.minimum_supplier_proposals) || null }
}