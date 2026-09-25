import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function migration(name: string): string {
  return readFileSync(
    resolve(process.cwd(), 'supabase/migrations', name),
    'utf8',
  );
}

describe('Postgres error remediation migrations', () => {
  it('stores the complete unsigned 64-bit hash range exactly', () => {
    const sql = migration('20260925000000_widen_synced_object_hash.sql');

    expect(sql).toContain('ALTER COLUMN hash TYPE numeric(20, 0)');
    expect(sql).toContain('18446744073709551616::numeric');
    expect(sql).toContain('18446744073709551615::numeric');
    expect(sql).toContain("SET external_id = 'hash-' || (");
  });

  it('creates the instance timeline index outside a transaction', () => {
    const sql = migration('20260925000100_index_instance_logs_timeline.sql');

    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(sql).toContain('(instance_id, created_at DESC)');
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
  });

});