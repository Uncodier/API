export const CAPABILITIES = ['text', 'tools', 'structured', 'vision', 'summary', 'embedding', 'image', 'speech', 'transcription', 'video'] as const;
export type Capability = typeof CAPABILITIES[number];
export type Recommendation = { modelId: string; reason: string; fingerprint: string; createdAt: string; vendorModels: Record<string, string> };
export type Verification = { modelId: string; credentialVersion: number; adapterVersion: string; expiresAt: string; operationId: string; artifactId: string; providerTag: string };
export type CapabilityPolicy = { mode: 'automatic' | 'manual' | 'disabled'; modelId: string | null; status: 'available' | 'unverified' | 'unavailable' | 'disabled'; reason: string; recommendation?: Recommendation; verification?: Verification; embeddingDimensions?: number };
export type Capabilities = Record<Capability, CapabilityPolicy>;
export type CatalogModel = { id: string; name: string; inputModalities: string[]; outputModalities: string[]; supportedParameters: string[]; contextLength: number | null;
  endpoints?: string[]; pricing?: Record<string, number>; maxCompletionTokens?: number | null; description?: string };
export type ConnectionRow = {
  id: string; site_id: string; status: 'connected' | 'disconnected'; selected: boolean;
  revision: number; policy_version: number; credential_version: number;
  encrypted_credential: string | null; capabilities: Capabilities; catalog: CatalogModel[];
  catalog_updated_at: string | null; verified_at: string | null; updated_at: string; consent_at: string | null;
};
export type CustomerSelection = { siteId: string; connectionId: string; revision: number; policyVersion: number; credentialVersion: number; capabilities: Capabilities };
export type CredentialReference = Pick<CustomerSelection, 'siteId' | 'connectionId' | 'policyVersion' | 'credentialVersion'>;
export class OpenRouterError extends Error {
  constructor(public code: string, message: string, public status = 503) { super(message); }
}
/** Explicit deployment admission; database site approval is an additional, independent gate. */
export function rolloutEnabled(): boolean {
  return routingStorageEnabled() && process.env.CUSTOMER_OPENROUTER_ENABLED === 'true';
}
/** Once deployed, keep storage reads enabled during rollback so pinned customer work cannot change payer. */
export function routingStorageEnabled(): boolean { return process.env.OPENROUTER_ROUTING_STORAGE_READY === 'true'; }
