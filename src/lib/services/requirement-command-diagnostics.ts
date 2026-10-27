import { z } from 'zod';
import { supabaseAdmin } from '@/lib/database/supabase-client';

const diagnosticSchema = z.object({
  state: z.enum(['applied', 'queued', 'blocked', 'none']),
  reason: z.string().nullable(),
  retryable: z.boolean(),
  checked_at: z.string().datetime({ offset: true }),
});

export type RequirementCommandDiagnostic = z.infer<typeof diagnosticSchema> | {
  state: 'unavailable';
  reason: 'diagnostic_unavailable';
  retryable: false;
  checked_at: null;
};

function unavailable(): RequirementCommandDiagnostic {
  // Unknown eligibility is not permission to resubmit or start execution.
  return { state: 'unavailable', reason: 'diagnostic_unavailable', retryable: false, checked_at: null };
}

/** Read-only, site-scoped snapshot; never applies commands or starts a runner. */
export async function inspectRequirementCommands(
  requirementIds: string[],
  siteId: string,
): Promise<Record<string, RequirementCommandDiagnostic>> {
  const ids = [...new Set(requirementIds)];
  const diagnostics: Record<string, RequirementCommandDiagnostic> = Object.fromEntries(
    ids.map(id => [id, unavailable()]),
  );
  if (ids.length === 0) return diagnostics;

  try {
    const { data, error } = await supabaseAdmin.rpc('inspect_requirement_commands', {
      p_requirement_ids: ids,
      p_site_id: siteId,
    });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) return diagnostics;
    for (const id of ids) {
      if (!Object.prototype.hasOwnProperty.call(data, id)) continue;
      const parsed = diagnosticSchema.safeParse(data[id]);
      if (parsed.success) diagnostics[id] = parsed.data;
    }
  } catch {
    // Inspection is best effort: preserve a successful persisted update/list,
    // and do not expose raw database errors or fabricate a checked timestamp.
  }
  return diagnostics;
}