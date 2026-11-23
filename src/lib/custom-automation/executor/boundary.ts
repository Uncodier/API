import type { AssistantExecutionBoundary } from '@/lib/services/robot-instance/assistant-execution-boundary';

export async function runBoundaryHook<T>(hook: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await hook();
  } catch (error) {
    // Only the exact host deadline may cross this wrapper. The durability
    // adapter has already rejected timeouts with unfinished effects.
    if (signal?.aborted && error === signal.reason && error instanceof DOMException && error.name === 'TimeoutError') throw error;
    // Do not retain arbitrary hook errors: they may contain arguments or credentials.
    const { AssistantExecutionBoundaryError } = await import('@/lib/services/robot-instance/assistant-execution-boundary');
    if (error instanceof AssistantExecutionBoundaryError) throw error;
    throw new AssistantExecutionBoundaryError();
  }
}

export async function runBoundaryBillingHook(hook: () => Promise<void>): Promise<void> {
  try {
    await hook();
  } catch (error: any) {
    if (['OpenRouterBillingError', 'RecoveryError'].includes(error?.name)) throw error;
    await runBoundaryHook(async () => { throw error; });
  }
}

export async function runStepHook(hook: () => Promise<void> | void, boundary?: AssistantExecutionBoundary): Promise<void> {
  try { await hook(); }
  catch (error) {
    if (boundary?.onStepError) {
      await runBoundaryHook(() => boundary.onStepError!(error), boundary.signal);
    }
    throw error;
  }
}

/** Never allow billing failures to be converted into a success or another model turn. */
class OpenRouterBillingError extends Error {
  constructor() {
    super('OpenRouter credit deduction unconfirmed; billing requires reconciliation');
    this.name = 'OpenRouterBillingError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function settleCompletion(siteId: string | undefined, eventId: string, usage: unknown, generationId?: string, model?: string) {
  if (!siteId) return;
  try {
    const { chargeOpenRouterUsage } = await import('@/lib/services/billing/openrouter-usage-billing');
    await chargeOpenRouterUsage({ siteId, eventId, usage, generationId,
      metadata: { model, context: 'custom-automation' } });
  } catch {
    throw new OpenRouterBillingError();
  }
}

export async function settleUncertainRequest(siteId: string | undefined, eventId: string, error: any, model: string) {
  const body = error?.error;
  const generationId = error?.generationId || body?.generation_id || body?.metadata?.generation_id;
  const usage = error?.usage || body?.usage;
  const rejectedBeforeConnection = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error?.cause?.code);
  if (generationId || usage || (!rejectedBeforeConnection && (typeof error?.status !== 'number' || error.status === 408))) {
    await settleCompletion(siteId, eventId, usage, generationId, model);
  }
}
