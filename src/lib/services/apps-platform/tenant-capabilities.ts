/** Public capability metadata only. Credentials never belong in this contract. */
export interface TenantCapabilities {
  version: 1;
  requirement_id: string;
  tenant_id: string;
  schema: string;
  identity: { user_id: string; claims: string; backend: string };
  storage: { bucket: string | null; available: boolean };
  backend: { role: 'authenticated'; bypasses_rls: false; operations: string[] };
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Reconstruct an allowlisted object: never serialize arbitrary RPC/env properties. */
export function parseTenantCapabilities(value: unknown, expected: {
  requirementId: string;
  tenantId?: string;
  schema?: string;
  bucket?: string;
}): TenantCapabilities {
  const v = value as Partial<TenantCapabilities> | null;
  if (!v || v.version !== 1 || v.requirement_id !== expected.requirementId ||
      !uuid.test(v.requirement_id) || typeof v.tenant_id !== 'string' || !uuid.test(v.tenant_id) ||
      (expected.tenantId && v.tenant_id !== expected.tenantId) ||
      typeof v.schema !== 'string' || !/^app_[a-f0-9]{24}$/.test(v.schema) ||
      (expected.schema && v.schema !== expected.schema) ||
      v.identity?.user_id !== `${v.schema}._app_current_user_id` ||
      v.identity?.claims !== `${v.schema}._app_request_claims` ||
      v.identity?.backend !== `${v.schema}._app_is_backend_request` ||
      typeof v.storage?.available !== 'boolean' ||
      (v.storage.available ? typeof v.storage.bucket !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v.storage.bucket) ||
        (expected.bucket !== undefined && v.storage.bucket !== expected.bucket) : v.storage.bucket !== null) ||
      v.backend?.role !== 'authenticated' || v.backend.bypasses_rls !== false ||
      !Array.isArray(v.backend.operations) || v.backend.operations.length !== 0) {
    throw new Error('Tenant capability receipt is missing, invalid, or belongs to another tenant.');
  }
  return {
    version: 1, requirement_id: v.requirement_id, tenant_id: v.tenant_id, schema: v.schema,
    identity: { user_id: v.identity.user_id, claims: v.identity.claims, backend: v.identity.backend },
    storage: { available: v.storage.available, bucket: v.storage.bucket },
    backend: { role: 'authenticated', bypasses_rls: false, operations: [] },
  };
}

export const TENANT_CAPABILITY_RULES = [
  'TENANT CAPABILITY CONTRACT (mandatory for database/auth/storage work):',
  '- Work only inside the provisioned tenant schema. A shared authenticated role is NOT tenant membership.',
  '- Use the verified identity helpers from the manifest. They read server-verified JWT claims; they do not authenticate credentials or grant data access.',
  '- Never assume auth.uid()/auth.jwt() are usable by the migration owner. Never create, alter, replace, rename or drop the reserved _app_* identity helpers.',
  '- In persistent SQL functions, use schema-qualified helper and table names from this manifest; do not rely on the caller\'s search_path.',
  '- Apply RLS using row ownership or protected local membership for each operation. Preserve the product\'s organization collaboration model; do not silently replace it with creator-only access.',
  '- Users cannot assign themselves roles, permissions or organizations. Submitted email and editable user_metadata are not authorization.',
  '- No cross-schema SQL, tenant enumeration, role/schema administration, GRANT/REVOKE, SECURITY DEFINER, claims mutation or global Storage DDL.',
  '- Static tenant SQL only; the runner owns search_path. Preserve applied migration bytes and use forward migrations.',
  '- A public form requires a narrow validated, rate-limited, transactional backend operation, not an open table policy. The backend JWT remains server-only, authenticated and subject to RLS.',
  '- An empty backend.operations list means no application RPC was registered by the platform. Do not invent an existing RPC or treat the backend identity helper as service_role.',
  '- Use only storage.bucket when storage.available is true. A registry bucket name alone is not proof that storage exists.',
  '- Missing/invalid helpers, bucket, permissions or JWT: report capability_gap with the exact operation/error to the harness. Do not request global privileges or weaken isolation.',
  '- Verify authorized access, anonymous denial, unrelated user/tenant denial, cross-org denial, role escalation, actual persistence, rollback and idempotency. Lint is not authorization proof.',
  '- Never print/read .env, tokens, signing keys or service credentials to discover capabilities. Use sandbox_db_capabilities for fresh metadata.',
].join('\n');

export function tenantCapabilitiesPrompt(value: unknown, requirementId: string): string {
  let capabilities: TenantCapabilities | undefined;
  try { capabilities = parseTenantCapabilities(value, { requirementId }); } catch { /* fail closed in prompt */ }
  return `${TENANT_CAPABILITY_RULES}\n${capabilities
    ? `VERIFIED TENANT CAPABILITIES (metadata only):\n${JSON.stringify(capabilities)}`
    : 'Tenant capabilities are NOT VERIFIED. Before database work, call sandbox_db_capabilities. Do not assume a schema, helper, bucket or backend operation.'}`;
}