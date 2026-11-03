import { z } from 'zod';

// Keep these identifiers aligned with the CRM's DEAL_STAGES and DEAL_STATUSES.
export const DEAL_STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation', 'closed_won', 'closed_lost'] as const;
export const DEAL_STATUSES = ['open', 'won', 'lost'] as const;

export const DealPipelineSchema = z.object({
  stage: z.enum(DEAL_STAGES).optional(),
  status: z.enum(DEAL_STATUSES).optional(),
});

export function dealValidationFeedback(error: z.ZodError) {
  const pipelineIssues = error.issues.filter(issue => issue.path[0] === 'stage' || issue.path[0] === 'status');
  return {
    success: false,
    code: 'INVALID_DEAL_DATA',
    error: pipelineIssues.length > 0
      ? `Invalid deal stage or status. Allowed stage values: ${DEAL_STAGES.join(', ')}. Allowed status values: ${DEAL_STATUSES.join(', ')}. For "Qualified", use stage="qualification", not "qualified". No changes were made; correct the arguments and retry.`
      : 'Invalid deal data. No changes were made; correct the fields in details and retry.',
    details: error.errors,
    allowed_values: { stage: DEAL_STAGES, status: DEAL_STATUSES },
    changes_made: false,
  };
}