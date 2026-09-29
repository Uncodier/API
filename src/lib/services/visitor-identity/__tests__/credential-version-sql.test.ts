import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(resolve(process.cwd(),
  'supabase/migrations/20260929221000_identity_credential_versions.sql'), 'utf8');

describe('credential version forward migration', () => {
  it('keeps the credential revision server-controlled on insert and update', () => {
    expect(migration).toContain('identity_token_version uuid not null default gen_random_uuid()');
    expect(migration).toContain('new.identity_token_version := gen_random_uuid()');
    expect(migration).toContain('then gen_random_uuid() else old.identity_token_version end');
    for (const field of ['status', 'site_id', 'user_id', 'lookup_hash', 'key_hash', 'scopes', 'expires_at']) {
      expect(migration).toContain(`new.${field} is distinct from old.${field}`);
    }
  });

  it('revokes direct service-role access to the old exchange helper', () => {
    expect(migration).toMatch(/revoke all on function public\.exchange_visitor_identity_token\([\s\S]*?from public, anon, authenticated, service_role/);
    expect(migration).toMatch(/grant execute on function public\.exchange_visitor_identity_token_v2\([\s\S]*?to service_role/);
    expect(migration).toContain('perform public.assert_visitor_identity_service_role()');
  });

  it('fences the version under the session/key locks before invoking the original atomic grant', () => {
    const sessionLock = migration.indexOf('perform pg_advisory_xact_lock');
    const versionCheck = migration.indexOf('and identity_token_version = p_key_version');
    const grant = migration.indexOf('return public.exchange_visitor_identity_token(');
    expect(sessionLock).toBeLessThan(versionCheck);
    expect(versionCheck).toBeLessThan(grant);
    expect(migration).toContain('for share;');
    expect(migration).toContain("set search_path = ''");
  });
});