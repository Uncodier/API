import { getTenantCapabilities } from '@/lib/services/apps-platform/tenant-capabilities-service';

export function sandboxDbCapabilitiesTool(requirementId?: string) {
  return {
    name: 'sandbox_db_capabilities',
    description: 'Read verified tenant identity helper names, actual storage availability and registered backend operations. Metadata only, no credentials. Does not provision or change permissions.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      if (!requirementId) return { success: false, failure_kind: 'capability_gap', error: 'No requirement is bound to this sandbox.' };
      try {
        const capabilities = await getTenantCapabilities(requirementId);
        return { success: true, capabilities, receipt: { kind: 'tenant_capabilities', requirement_id: requirementId, version: 1 } };
      } catch {
        return { success: false, failure_kind: 'capability_gap', error: 'Verified tenant capabilities unavailable. Ask the harness to repair provisioning; do not change global grants or infer helpers.' };
      }
    },
  };
}