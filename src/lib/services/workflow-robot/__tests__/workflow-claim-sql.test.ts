import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260918233600_workflow_run_claim_leases.sql',
  ),
  'utf8',
);

describe('workflow run claim leases migration', () => {
  it('supports expired claims with token-fenced renewal and finalization', () => {
    expect(migration).toContain('claim_expires_at');
    expect(migration).toContain('claim_token = p_claim_token');
    expect(migration).toContain('claim_expires_at <= timezone');
    expect(migration).toContain('renew_workflow_run_execution_claim');
    expect(migration).toContain('finish_workflow_run_execution');
  });

  it('keeps claim RPCs private to the service role', () => {
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
  });
});
