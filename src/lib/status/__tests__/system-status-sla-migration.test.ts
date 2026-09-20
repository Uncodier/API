import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260920004000_harden_system_status_sla.sql',
  ),
  'utf8',
);

describe('system status SLA hardening migration', () => {
  it('removes the redundant status history index', () => {
    expect(migration).toContain(
      'DROP INDEX IF EXISTS public.idx_system_status_system_created;',
    );
  });

  it('limits SLA scans to the supported 30-day window', () => {
    expect(migration).toContain(
      "GREATEST(\n    COALESCE(p_since, NOW() - INTERVAL '30 days'),\n    NOW() - INTERVAL '30 days'\n  )",
    );
  });

  it('keeps the RPC executable only by the service role', () => {
    expect(migration).toContain(
      'FROM PUBLIC, anon, authenticated;',
    );
    expect(migration).toContain(
      'TO service_role;',
    );
  });
});
