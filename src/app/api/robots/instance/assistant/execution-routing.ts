import { rolloutEnabled } from '@/lib/integrations/openrouter/types';
import { getExecutionRouting, resolveExecutionRouting, withExecutionRouting,
  requiresPlatformInferenceCredits, type ExecutionRoutingReference } from '@/lib/services/ai/customer-routing';

/** Host-only admission, after site authorization. Disabled rollout must not read new tables. */
export async function admitAssistantRouting(siteId: string): Promise<ExecutionRoutingReference> {
  return getExecutionRouting(siteId) ?? (rolloutEnabled()
    ? await resolveExecutionRouting(siteId) : { payer: 'platform', siteId });
}

/** Legacy jobs remain platform-funded; resumes never resolve today's selection. */
export function withAssistantRouting<T>(siteId: string, pinned: ExecutionRoutingReference | undefined,
  operation: () => Promise<T>): Promise<T> {
  return withExecutionRouting(pinned ?? getExecutionRouting(siteId) ?? { payer: 'platform', siteId }, siteId, operation);
}

export function validateAssistantInferenceAdmission(siteId: string, pinned: ExecutionRoutingReference) {
  return withAssistantRouting(siteId, pinned, async () => {
    if (!requiresPlatformInferenceCredits(siteId)) return true;
    const { CreditService } = await import('@/lib/services/billing/CreditService');
    return CreditService.validateCredits(siteId, 0.001);
  });
}