import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260923223000_add_workflow_database_webhooks.sql',
  ),
  'utf8',
);

describe('workflow database webhook migration', () => {
  it('uses Vault-backed configuration instead of copying another trigger', () => {
    expect(migration).toContain('vault.decrypted_secrets');
    expect(migration).toContain("'workflow_webhook_url'");
    expect(migration).toContain("'workflow_webhook_api_key'");
    expect(migration).not.toContain('pg_get_triggerdef');
  });

  it.each([
    'leads',
    'deals',
    'conversations',
    'tasks',
    'quotations',
    'reservations',
    'content',
    'sales',
  ])('installs the shared trigger for %s', (table) => {
    expect(migration).toContain(`'${table}'`);
  });

  it('preserves both record snapshots in the database webhook payload', () => {
    expect(migration).toContain("'record', CASE");
    expect(migration).toContain("'old_record', CASE");
  });
});
