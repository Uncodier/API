import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

const legacyMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260917204400_atomic_session_recording_chunk.sql',
  ),
  'utf8',
);
const batchMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260918233300_session_recording_chunk_batches.sql',
  ),
  'utf8',
);
const consolidationMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260918233100_consolidate_session_recordings.sql',
  ),
  'utf8',
);
const orderedIndexMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260918233000_session_recording_ordered_lookup.sql',
  ),
  'utf8',
);
const legacyWrapperMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260918233500_legacy_recording_rpc_wrapper.sql',
  ),
  'utf8',
);
const route = fs.readFileSync(
  path.join(process.cwd(), 'src/app/api/visitors/record/route.ts'),
  'utf8',
);

describe('atomic session recording persistence', () => {
  it('serializes writes per session and deduplicates storage paths', () => {
    expect(legacyMigration).toContain('pg_advisory_xact_lock');
    expect(batchMigration).toContain('pg_advisory_xact_lock');
    expect(batchMigration).toContain('session_recording_chunks');
    expect(batchMigration).toContain('ON CONFLICT DO NOTHING');
    expect(batchMigration).toContain("'duplicate_chunks'");
  });

  it('keeps the RPC private to the service role', () => {
    expect(batchMigration).toContain(
      'FROM PUBLIC, anon, authenticated',
    );
    expect(batchMigration).toContain('TO service_role');
  });

  it('consolidates historical duplicates in bounded batches', () => {
    expect(orderedIndexMigration).toContain(
      '(session_id, created_at, id)',
    );
    expect(consolidationMigration).toContain(
      'consolidate_session_recording_duplicates',
    );
    expect(consolidationMigration).toContain('p_row_limit integer DEFAULT 100');
    expect(consolidationMigration).toContain('merged_manifest');
    expect(consolidationMigration).toContain(
      'DELETE FROM public.session_events',
    );
  });

  it('uses stable chunk identities and one metadata RPC per request', () => {
    expect(route).toContain('input.chunk_id');
    expect(route).toContain('upsert: false');
    expect(route).toContain("createHash('sha256')");
    expect(route).toContain("'append_session_recording_chunks'");
  });

  it('routes legacy single-chunk RPC calls through the batch implementation', () => {
    expect(legacyWrapperMigration).toContain(
      'public.append_session_recording_chunks',
    );
    expect(legacyWrapperMigration).toContain('jsonb_build_array');
  });
});
