import { z } from 'zod';
import type { DbContent } from '@/lib/database/content-db';
import { supabaseAdmin } from '@/lib/database/supabase-client';

type ClaimFields = {
  text?: string;
  status: 'draft' | 'published';
  published_at?: string | null;
  metadata: Record<string, unknown>;
};

const timestamp = z.string().datetime({ offset: true });
const snapshotSchema = z.object({
  id: z.string().uuid(),
  site_id: z.string().uuid(),
  updated_at: timestamp,
  metadata: z.record(z.unknown()).nullable(),
});
const fieldsSchema = z.object({
  text: z.string().optional(),
  status: z.enum(['draft', 'published']),
  published_at: timestamp.nullable().optional(),
  metadata: z.record(z.unknown()),
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function claimError(): Error {
  return new Error('Content could not be claimed for social publishing. Refresh its status before retrying; no post was sent.');
}

/** Internal server boundary: the caller must already authorize execution for siteId. */
export async function claimSocialContent(
  existing: DbContent,
  siteId: string,
  fields: ClaimFields,
): Promise<{ id: string; status: string }> {
  try {
    const snapshot = snapshotSchema.parse(existing);
    if (!z.string().uuid().safeParse(siteId).success || snapshot.site_id !== siteId) throw claimError();
    const update = fieldsSchema.parse(fields);
    const previousAttempt = snapshot.metadata?.social_publication;
    const nextAttempt = update.metadata.social_publication;
    if (!record(nextAttempt) || typeof nextAttempt.attempt_id !== 'string' || !nextAttempt.attempt_id.trim()
      || (record(previousAttempt) && previousAttempt.attempt_id === nextAttempt.attempt_id)) throw claimError();

    // Serialize before touching the service client; malformed/circular metadata cannot weaken the claim.
    const previousMetadata = snapshot.metadata === null ? null : JSON.stringify(snapshot.metadata);
    const nextMetadata: unknown = JSON.parse(JSON.stringify(update.metadata));
    if ((previousMetadata !== null && !record(JSON.parse(previousMetadata))) || !record(nextMetadata)
      || !record(nextMetadata.social_publication)
      || nextMetadata.social_publication.attempt_id !== nextAttempt.attempt_id) throw claimError();

    let query = supabaseAdmin.from('content')
      .update({ ...update, metadata: nextMetadata, updated_at: new Date().toISOString() })
      .eq('id', snapshot.id)
      .eq('site_id', siteId)
      .eq('updated_at', snapshot.updated_at);
    // Metadata includes a fresh attempt ID, so CAS still excludes a loser within the same millisecond.
    query = previousMetadata === null ? query.is('metadata', null) : query.eq('metadata', previousMetadata);
    const { data, error } = await query.select('id,status').maybeSingle();
    if (error || !data || data.id !== snapshot.id || data.status !== update.status) throw claimError();
    return { id: data.id, status: data.status };
  } catch {
    // Database and configuration details must never escape this internal service-role boundary.
    throw claimError();
  }
}