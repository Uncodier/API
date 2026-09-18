import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const initialMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260917210000_visitor_identity_verification.sql'),
  'utf8'
);
const hardeningMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260917233000_visitor_identity_verification_hardening.sql'),
  'utf8'
);
const idempotencyMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260918013500_reuse_active_visitor_identity_challenge.sql'),
  'utf8'
);
const migration = `${initialMigration}\n${hardeningMigration}\n${idempotencyMigration}`;

describe('visitor identity SQL contract', () => {
  it('keeps identity tables private and RPCs service-role only', () => {
    expect(migration).toContain('force row level security');
    expect(migration).toMatch(/revoke all on public\.visitor_identity_challenges from public, anon, authenticated/i);
    expect(migration).toMatch(/auth\.role\(\)[\s\S]*service_role/);
    expect(migration).toMatch(/security definer/gi);
  });

  it('enforces expiry, attempt, cooldown, and resend limits', () => {
    expect(migration).toContain("interval '10 minutes'");
    expect(migration).toContain('attempts between 0 and 5');
    expect(migration).toContain("interval '60 seconds'");
    expect(migration).toContain('resend_count between 0 and 3');
    expect(migration).toContain('v_challenge.resend_count >= 3');
    expect(migration).toContain('v_attempts >= 5');
  });

  it('locks and atomically consumes, grants, and binds identity', () => {
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toMatch(/for update/gi);
    expect(migration).toContain('verify_consume_visitor_identity_challenge');
    expect(migration).toMatch(/set consumed_at = v_now[\s\S]*insert into public\.visitor_session_identity_grants/);
    expect(migration).toMatch(/insert into public\.visitor_session_identity_grants[\s\S]*update public\.visitor_sessions/);
    expect(hardeningMigration).toContain('p_is_match boolean');
    expect(hardeningMigration).toContain(
      'create or replace function public.verify_consume_visitor_identity_challenge'
    );
    expect(hardeningMigration).not.toMatch(/v_challenge\.otp_hash\s*(=|<>)\s*p_/);
  });

  it('removes prior authorization before issuing a challenge for another identity', () => {
    expect(migration).toMatch(
      /issue_visitor_identity_challenge[\s\S]*update public\.visitor_session_identity_grants[\s\S]*set revoked_at = v_now/
    );
    expect(migration).toMatch(
      /issue_visitor_identity_challenge[\s\S]*update public\.visitor_sessions[\s\S]*set lead_id = null/
    );
  });

  it('reuses an active matching challenge before applying the issuance limit', () => {
    const existingChallengeCheck = idempotencyMigration.indexOf("'status', 'existing'");
    const rateLimitCheck = idempotencyMigration.indexOf("v_recent_count >= 5");

    expect(existingChallengeCheck).toBeGreaterThan(-1);
    expect(rateLimitCheck).toBeGreaterThan(existingChallengeCheck);
    expect(idempotencyMigration).toMatch(
      /session_id = p_session_id[\s\S]*lead_id = p_lead_id[\s\S]*expires_at > v_now/
    );
  });

  it('never defines a plaintext OTP column', () => {
    expect(migration).toContain('otp_hash text not null');
    expect(migration).not.toMatch(/\botp_code\b|\bplaintext_otp\b/i);
  });

  it('revokes the session identity without leaving a stale lead binding', () => {
    expect(migration).toMatch(
      /revoke_visitor_session_identity[\s\S]*update public\.visitor_sessions[\s\S]*set lead_id = null/
    );
  });
});
