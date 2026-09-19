import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260918233900_persist_tracking_event_batches.sql',
  ),
  'utf8',
);

describe('tracking event persistence SQL contract', () => {
  it('persists a bounded batch idempotently in one RPC', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.persist_tracking_event_batch',
    );
    expect(migration).toContain(
      "RAISE EXCEPTION 'Tracking batch must contain 1-100 events'",
    );
    expect(migration).toMatch(/ON CONFLICT\s*\(\s*id\s*\)\s*DO NOTHING/);
    expect(migration).toContain(
      "RAISE EXCEPTION 'Tracking event ID conflicts with existing event'",
    );
  });

  it('checks session ownership and restricts execution to service role', () => {
    expect(migration).toContain(
      "RAISE EXCEPTION 'Tracking batch has conflicting session ownership'",
    );
    expect(migration).toContain(
      "RAISE EXCEPTION 'Tracking session ownership conflict'",
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.persist_tracking_event_batch\(jsonb\)\s+TO service_role/,
    );
  });
});
