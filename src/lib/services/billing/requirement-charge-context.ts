import { AsyncLocalStorage } from 'node:async_hooks';

type ChargeContext = { siteId: string; requirementId: string; sessionId: string };
const contexts = new AsyncLocalStorage<ChargeContext>();

/** Host-only attribution, not permission or a new charge. Never read model args. */
export function withRequirementChargeContext<T>(context: ChargeContext, operation: () => T): T {
  return contexts.run({ ...context }, operation);
}

export function requirementChargeMetadata(siteId: string): Record<string, string> {
  const context = contexts.getStore();
  if (!context) return {};
  if (context.siteId !== siteId) throw new Error('Requirement charge tenant mismatch');
  return { requirement_id: context.requirementId, session_id: context.sessionId };
}