import { z } from 'zod';
import { CAPABILITIES, type Capabilities, type ConnectionRow, OpenRouterError } from './types';
import { modelIdSchema } from './catalog';
const capabilitySchema = z.object({ mode: z.enum(['automatic', 'manual', 'disabled']), modelId: modelIdSchema.nullable(), status: z.enum(['available', 'unverified', 'unavailable', 'disabled']), reason: z.string().max(1000),
  recommendation: z.object({ modelId: modelIdSchema, reason: z.string().max(800), fingerprint: z.string().length(64), createdAt: z.string().datetime(), vendorModels: z.record(z.string().max(80), modelIdSchema) }).strict().optional(),
  verification: z.object({ modelId: modelIdSchema, credentialVersion: z.number().int().positive(), adapterVersion: z.string().max(100), expiresAt: z.string().datetime(), operationId: z.string().uuid(), artifactId: z.string().max(300), providerTag: z.string().regex(/^[a-zA-Z0-9._/-]+$/).max(100) }).strict().optional(),
  embeddingDimensions: z.number().int().min(1).max(65536).optional(),
}).strict();
export const capabilitiesSchema = z.object(Object.fromEntries(CAPABILITIES.map(key => [key, capabilitySchema])) as Record<typeof CAPABILITIES[number], typeof capabilitySchema>).strict();
const catalogModel = z.object({ id: modelIdSchema, name: z.string().max(300), inputModalities: z.array(z.string()).max(20), outputModalities: z.array(z.string()).max(20), supportedParameters: z.array(z.string()).max(100), contextLength: z.number().positive().nullable(),
  endpoints: z.array(z.string().max(120)).max(30).optional(), pricing: z.record(z.number().finite().nonnegative()).optional(), maxCompletionTokens: z.number().positive().nullable().optional(), description: z.string().max(600).optional() }).strict();
export const rowSchema = z.object({
  id: z.string().uuid(), site_id: z.string().uuid(), status: z.enum(['connected', 'disconnected']), selected: z.boolean(),
  revision: z.number().int().positive(), policy_version: z.number().int().positive(), credential_version: z.number().int().positive(),
  encrypted_credential: z.string().max(20000).nullable(), capabilities: capabilitiesSchema, catalog: z.array(catalogModel).max(10000),
  catalog_updated_at: z.string().nullable(), verified_at: z.string().nullable(), consent_at: z.string().nullable(), updated_at: z.string(),
});
export function parseRow(value: unknown): ConnectionRow {
  const result = rowSchema.safeParse(value);
  if (!result.success || (result.data.selected && (result.data.status !== 'connected' || !result.data.consent_at)) ||
    (result.data.status === 'connected' && !result.data.encrypted_credential)) throw new OpenRouterError('invalid_connection', 'Connection state is invalid');
  return result.data as ConnectionRow;
}
export function parseCapabilities(value: unknown): Capabilities {
  const parsed = capabilitiesSchema.safeParse(value);
  if (!parsed.success) throw new OpenRouterError('invalid_policy', 'Connection policy is invalid');
  return parsed.data as Capabilities;
}
const policyInput = z.object({ mode: z.enum(['automatic', 'manual', 'disabled']), modelId: modelIdSchema.nullable().optional(), embeddingDimensions: z.number().int().min(1).max(65536).optional() }).strict();
const common = { siteId: z.string().uuid(), expectedRevision: z.number().int().min(0).max(2147483646) };
export const mutationSchema = z.discriminatedUnion('operation', [
  z.object({ ...common, operation: z.literal('connect'), apiKey: z.string().min(12).max(4096).regex(/^[\x21-\x7e]+$/), consent: z.literal(true), selected: z.boolean().optional() }).strict(),
  z.object({ ...common, operation: z.literal('configure'), selected: z.boolean().optional(), consent: z.literal(true).optional(), capabilities: z.object(Object.fromEntries(CAPABILITIES.map(key => [key, policyInput.optional()])) as Record<typeof CAPABILITIES[number], z.ZodOptional<typeof policyInput>>).strict().optional() }).strict(),
  z.object({ ...common, operation: z.literal('refresh') }).strict(),
  z.object({ ...common, operation: z.literal('disconnect') }).strict(),
  z.object({ ...common, operation: z.literal('recommend'), operationId: z.string().uuid(), consent: z.literal(true), maxCostUsd: z.number().min(0.001).max(1),
    preferredVendor: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(80).optional(), maxPromptPrice: z.number().nonnegative().max(100).default(5), maxCompletionPrice: z.number().nonnegative().max(500).default(20) }).strict(),
  z.object({ ...common, operation: z.literal('verify'), operationId: z.string().uuid(), consent: z.literal(true), capability: z.literal('image'), modelId: modelIdSchema, maxCostUsd: z.number().min(0.001).max(1) }).strict(),
  z.object({ ...common, operation: z.literal('recover_verification'), operationId:z.string().uuid() }).strict(),
]);
export type Mutation = z.infer<typeof mutationSchema>;
