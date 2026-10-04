import { resolveOpenRouterModel } from '@/lib/services/ai/openrouter';

/** Resolve once for history budgeting and pin the same model on execution options. */
export function resolveAssistantHistoryModel() {
  return { provider: 'openrouter' as const, model: resolveOpenRouterModel() };
}