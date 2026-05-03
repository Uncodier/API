/**
 * Server-only client and helpers for the **Apps Supabase** project (currently
 * shared with the `repositories` project). This is intentionally separate from
 * the storage helper that already uses `REPOSITORY_SUPABASE_*` envs — do NOT
 * mix them: storage upload uses the anon key + RLS, while
 * `getAppsAdminClient()` uses the service role to provision schemas, run
 * migrations and emit tenant JWTs.
 *
 * NEVER bundle these envs into the dashboard client. Read the matrix at
 * `docs/apps-platform-setup.md` (Phase 2c of the harness plan).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;

interface AppsSupabaseEnv {
  url: string;
  serviceKey: string;
  jwtSecret: string;
  anonKey: string;
}

function readAppsEnv(): AppsSupabaseEnv {
  const url = process.env.APPS_SUPABASE_URL || process.env.REPOSITORY_SUPABASE_URL;
  const serviceKey =
    process.env.APPS_SUPABASE_SERVICE_KEY || process.env.REPOSITORY_SUPABASE_SERVICE_ROLE_KEY;
  const jwtSecret = process.env.APPS_SUPABASE_JWT_SECRET;
  const anonKey =
    process.env.APPS_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_APPS_SUPABASE_ANON_KEY ||
    process.env.REPOSITORY_SUPABASE_ANON_KEY ||
    '';
  if (!url || !serviceKey) {
    throw new Error(
      'apps-supabase: missing APPS_SUPABASE_URL / APPS_SUPABASE_SERVICE_KEY (alias REPOSITORY_SUPABASE_*).',
    );
  }
  if (!jwtSecret) {
    throw new Error(
      'apps-supabase: missing APPS_SUPABASE_JWT_SECRET. Get it from Supabase dashboard → Settings → API → JWT Secret.',
    );
  }
  return { url, serviceKey, jwtSecret, anonKey };
}

/** Server-only admin client. Never expose to the dashboard bundle. */
export function getAppsAdminClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const { url, serviceKey } = readAppsEnv();
  cachedClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

export function getAppsPublicConfig(): { url: string; anonKey: string } {
  const { url, anonKey } = readAppsEnv();
  return { url, anonKey };
}

interface IssueTenantJWTInput {
  tenant_id: string;
  schema: string;
  /** Convenience: also embed the user id in the `sub` claim if provided. */
  user_id?: string;
  /** Default 7 days for sandbox-injected, server-only JWTs. */
  expiresInSec?: number;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Sign a Supabase-compatible HS256 JWT with the Apps project secret. The
 * token carries `tenant_id` for informational purposes, and `role: 'authenticated'` 
 * so PostgREST treats requests as user-level (never service). Schema is included 
 * for clarity. The security boundary relies on the dynamic schema execution
 * context (`.schema('app_<id>')`) combined with local RLS ownership policies.
 */
export async function issueTenantJWT(input: IssueTenantJWTInput): Promise<{ token: string; expires_at: string }> {
  const { tenant_id, schema, user_id, expiresInSec = 60 * 60 * 24 * 7 } = input;
  const { jwtSecret } = readAppsEnv();
  const { createHmac } = await import('node:crypto');

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + expiresInSec;

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    role: 'authenticated',
    aud: 'authenticated',
    tenant_id,
    schema,
    sub: user_id || tenant_id,
    iat: nowSec,
    exp: expSec,
  };

  const headerEnc = base64url(JSON.stringify(header));
  const payloadEnc = base64url(JSON.stringify(payload));
  const signingInput = `${headerEnc}.${payloadEnc}`;
  const signature = base64url(createHmac('sha256', jwtSecret).update(signingInput).digest());

  return {
    token: `${signingInput}.${signature}`,
    expires_at: new Date(expSec * 1000).toISOString(),
  };
}
