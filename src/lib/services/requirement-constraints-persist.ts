import { extractRequirementConstraints } from '@/lib/services/requirement-constraints';
import { mutateBacklogAtomically } from '@/lib/services/requirement-backlog-mutation';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { patchRequirementMetadataKeys } from './requirement-metadata-patch';

/**
 * Stamp MUST NOT lines onto backlog items and requirement metadata so the
 * gate/judge do not depend only on truncated prompt instructions.
 */
export async function persistExtractedConstraints(
  requirementId: string,
  ...blocks: Array<string | null | undefined>
): Promise<string[]> {
  const extracted = extractRequirementConstraints(...blocks);
  const texts = extracted.map((c) => c.text);
  if (!texts.length) return [];

  try {
    await mutateBacklogAtomically(
      requirementId,
      ({ backlog }) => {
        let changed = false;
        backlog.items = backlog.items.map((item) => {
          if (item.constraints && item.constraints.length > 0) return item;
          changed = true;
          return { ...item, constraints: texts };
        });
        return {
          result: undefined,
          write: changed,
        };
      },
    );

    await patchRequirementMetadataKeys({
      requirementId,
      patch: { extracted_constraints: texts },
    });
  } catch (e) {
    console.warn(
      '[Constraints] persistExtractedConstraints failed:',
      e instanceof Error ? e.message : e,
    );
  }
  return texts;
}

/** Blocks the executor/gate should scan — persisted metadata plus spec text. */
export async function loadConstraintSourceBlocks(requirementId: string): Promise<string[]> {
  const id = String(requirementId || '').trim();
  if (!id) return [];
  try {
    const { data } = await supabaseAdmin
      .from('requirements')
      .select('instructions, title, metadata, backlog')
      .eq('id', id)
      .maybeSingle();
    if (!data) return [];
    const meta = (data.metadata || {}) as { extracted_constraints?: string[] };
    const items = ((data.backlog as { items?: Array<{ constraints?: string[]; acceptance?: string[] }> } | null)?.items) || [];
    return [
      data.instructions,
      data.title,
      ...(Array.isArray(meta.extracted_constraints) ? meta.extracted_constraints : []),
      ...items.flatMap((item) => [...(item.constraints || []), ...(item.acceptance || [])]),
    ].filter((b): b is string => typeof b === 'string' && b.trim().length > 0);
  } catch (e) {
    console.warn(
      '[Constraints] loadConstraintSourceBlocks failed:',
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}
