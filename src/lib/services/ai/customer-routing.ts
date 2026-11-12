import { AsyncLocalStorage } from 'node:async_hooks';
import { supportsChatContract, type ChatCapability } from '@/lib/integrations/openrouter/chat-contract';

export type CustomerCapability = 'text' | 'tools' | 'structured' | 'vision' | 'summary' |
  'embedding' | 'image' | 'speech' | 'transcription' | 'video';
export type ExecutionRoutingReference = Readonly<{
  payer: 'platform'; siteId: string;
} | {
  payer: 'customer'; siteId: string; connectionId: string;
  policyVersion: number; credentialVersion: number;
}>;

export class CustomerRoutingError extends Error {
  /** Confirmed pre-dispatch/rejected request only; prevents legacy uncertain-charge handling. */
  readonly status: number;
  constructor(readonly code: string = 'CUSTOMER_ROUTE_UNAVAILABLE') {
    super('Customer OpenRouter routing is unavailable; platform fallback is prohibited');
    this.name = 'CustomerRoutingError';
    this.status = code === 'CUSTOMER_FUNDING_REQUIRED' ? 402 : 422;
  }
}

const scopes = new AsyncLocalStorage<ExecutionRoutingReference>();
const capabilities = new AsyncLocalStorage<CustomerCapability>();
const operations = new AsyncLocalStorage<{ id: string; ordinal: number }>();

/** Semantic intent is host code, never a request parameter or prompt heuristic. */
export function withCustomerCapability<T>(capability: CustomerCapability, operation: () => Promise<T>): Promise<T> {
  return capabilities.run(capability, operation);
}

export function getCustomerCapability(): CustomerCapability | undefined { return capabilities.getStore(); }

/** A replay starts the same ordinal sequence; an uncertain dispatch is never reissued. */
export function withCustomerOperation<T>(operationId: string, operation: () => Promise<T>,
  options: { durableBoundary?: boolean } = {}): Promise<T> {
  if (!operationId || operationId.length > 256) throw new CustomerRoutingError('INVALID_OPERATION_ID');
  const parent = operations.getStore();
  // A new durable actor has its own stable identity even during immediate HTTP dispatch.
  // Re-entering the same actor must not reset its ordinal and duplicate earlier calls.
  return parent && (!options.durableBoundary || parent.id === operationId)
    ? operation() : operations.run({ id: operationId, ordinal: 0 }, operation);
}

export function getCustomerOperationKey(): string | undefined {
  const operation = operations.getStore();
  return operation ? `${operation.id}:${operation.ordinal++}` : undefined;
}

/** Host-only API: callers must authorize this site before resolving privileged storage. */
export async function resolveExecutionRouting(siteId: string): Promise<ExecutionRoutingReference> {
  if (!siteId) throw new CustomerRoutingError('ROUTING_SITE_REQUIRED');
  const { getCustomerSelection } = await import('@/lib/integrations/openrouter/store');
  const selection = await getCustomerSelection(siteId);
  if (!selection) return Object.freeze({ payer: 'platform', siteId });
  return reference({ payer: 'customer', siteId, connectionId: selection.connectionId,
    policyVersion: selection.policyVersion, credentialVersion: selection.credentialVersion }, siteId);
}

/** Explicit whitelist: never carry request fields, credentials or model prompts durably. */
function reference(value: ExecutionRoutingReference, siteId: string): ExecutionRoutingReference {
  if (!value || value.siteId !== siteId || !siteId) throw new CustomerRoutingError('ROUTING_SITE_MISMATCH');
  if (value.payer === 'platform') return Object.freeze({ payer: 'platform', siteId });
  if (value.payer !== 'customer' || !value.connectionId ||
      !Number.isSafeInteger(value.policyVersion) || value.policyVersion < 1 ||
      !Number.isSafeInteger(value.credentialVersion) || value.credentialVersion < 1) {
    throw new CustomerRoutingError('INVALID_ROUTING_REFERENCE');
  }
  return Object.freeze({ payer: 'customer', siteId, connectionId: value.connectionId,
    policyVersion: value.policyVersion, credentialVersion: value.credentialVersion });
}

export function getExecutionRouting(siteId?: string): ExecutionRoutingReference | undefined {
  const current = scopes.getStore();
  if (current && siteId && current.siteId !== siteId) throw new CustomerRoutingError('ROUTING_SITE_MISMATCH');
  return current;
}

/** Restore only from host-owned job state, never request JSON. ALS is not durable storage. */
export async function withExecutionRouting<T>(value: ExecutionRoutingReference, siteId: string,
  operation: () => Promise<T>): Promise<T> {
  const pinned = reference(value, siteId);
  const parent = getExecutionRouting();
  if (parent && JSON.stringify(parent) !== JSON.stringify(pinned)) {
    throw new CustomerRoutingError('ROUTING_CHILD_REBIND_FORBIDDEN');
  }
  // Keep dispatch proof/client identity stable in same-execution nested wrappers.
  const active = parent ?? pinned;
  if (pinned.payer === 'customer') {
    const { resolveCustomerCredential } = await import('@/lib/integrations/openrouter/store');
    // Revalidate authorization/revocation on resume; never store the returned secret.
    await resolveCustomerCredential(pinned);
  }
  return scopes.run(active, operation);
}

export async function resolveCustomerDispatch(value: ExecutionRoutingReference,
  capability: CustomerCapability, requiredChatCapabilities: readonly ChatCapability[] = []): Promise<{ apiKey: string; modelId: string; contextLength: number | null;
    maxCompletionTokens?: number | null; embeddingDimensions?: number; providerTag?: string }> {
  const pinned = reference(value, value.siteId);
  if (pinned.payer !== 'customer') throw new CustomerRoutingError('CUSTOMER_ROUTE_REQUIRED');
  const { resolveCustomerCredential } = await import('@/lib/integrations/openrouter/store');
  const resolved = await resolveCustomerCredential(pinned);
  const route = resolved.capabilities[capability];
  const model = resolved.catalog?.find(model => model.id === route?.modelId);
  if (!resolved.apiKey?.trim() || !route || route.mode === 'disabled' || !route.modelId ||
      !['available', 'unverified'].includes(route.status) ||
      !model || (capability === 'image' && route.status !== 'available')) {
    throw new CustomerRoutingError('CUSTOMER_CAPABILITY_UNAVAILABLE');
  }
  if (capability === 'image') {
    const proof = route.verification;
    if (!proof || proof.modelId !== route.modelId || proof.credentialVersion !== pinned.credentialVersion ||
      proof.adapterVersion !== 'openrouter-images-png-v1' || !Number.isFinite(Date.parse(proof.expiresAt)) ||
      Date.parse(proof.expiresAt) <= Date.now() || !proof.artifactId || !proof.operationId ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(proof.providerTag ?? '')) {
      throw new CustomerRoutingError('CUSTOMER_IMAGE_VERIFICATION_REQUIRED');
    }
  }
  if (requiredChatCapabilities.length) {
    for (const required of requiredChatCapabilities) {
      const policy = resolved.capabilities[required];
      if (!policy || policy.mode === 'disabled' || !['available','unverified'].includes(policy.status) || !policy.modelId) {
        throw new CustomerRoutingError('CUSTOMER_CAPABILITY_UNAVAILABLE');
      }
    }
    if (!supportsChatContract(model, requiredChatCapabilities)) {
      throw new CustomerRoutingError('CUSTOMER_COMBINED_CAPABILITY_UNSUPPORTED');
    }
  }
  return { apiKey: resolved.apiKey, modelId: route.modelId, contextLength: model.contextLength,
    maxCompletionTokens: model.maxCompletionTokens, embeddingDimensions: route.embeddingDimensions,
    providerTag: capability === 'image' ? route.verification?.providerTag : undefined };
}

export function assertPlatformInference(capability: string): void {
  if (getExecutionRouting()?.payer === 'customer') {
    throw new CustomerRoutingError(`CUSTOMER_ADAPTER_UNSUPPORTED_${capability.toUpperCase()}`);
  }
}

/** Inference only. Never apply this exemption to VMs, tools, channels or other resources. */
export function requiresPlatformInferenceCredits(siteId: string): boolean {
  return getExecutionRouting(siteId)?.payer !== 'customer';
}