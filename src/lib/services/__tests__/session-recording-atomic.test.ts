import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260917204400_atomic_session_recording_chunk.sql',
  ),
  'utf8',
);
const route = fs.readFileSync(
  path.join(process.cwd(), 'src/app/api/visitors/record/route.ts'),
  'utf8',
);

describe('atomic session recording persistence', () => {
  it('serializes writes per session and deduplicates storage paths', () => {
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('v_chunk_manifest');
    expect(migration).toContain('p_content_hash');
    expect(migration).toContain("'state', 'duplicate'");
  });

  it('keeps the RPC private to the service role', () => {
    expect(migration).toContain(
      'FROM PUBLIC, anon, authenticated',
    );
    expect(migration).toContain('TO service_role');
  });

  it('uses stable chunk identities for idempotent storage and metadata writes', () => {
    expect(route).toContain('body.chunk_id');
    expect(route).toContain('upsert: false');
    expect(route).toContain("createHash('sha256')");
    expect(route).toContain("'append_session_recording_chunk'");
  });
});
