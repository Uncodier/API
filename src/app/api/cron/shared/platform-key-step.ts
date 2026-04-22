'use step';

import { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { ensurePlatformKeyForRequirement } from '@/lib/services/platform-api/ensure-platform-key';
import { ensureTenant, type AppsAuthProvider } from '@/lib/services/apps-platform/tenant-provisioner';
import { getAppsPublicConfig } from '@/lib/database/apps-supabase';
import type { CronAuditContext } from '@/lib/services/cron-audit-log';

export interface ProvisionPlatformKeyStepInput {
  sandboxId: string;
  requirementId: string;
  siteId: string;
  userId: string;
  instanceId: string;
  apiBaseUrl?: string;
  /** Defaults to 'supabase'. Skips tenant provisioning when set to null. */
  authProvider?: AppsAuthProvider | null;
  audit?: CronAuditContext;
}

export interface ProvisionPlatformKeyStepResult {
  platform_key_id: string;
  created: boolean;
  expires_at: string;
  /** True when we wrote a new key into `.env.local`; false when reusing an existing active key. */
  env_injected: boolean;
  tenant?: {
    tenant_id: string;
    schema: string;
    bucket: string;
    auth_provider: AppsAuthProvider;
    created: boolean;
    jwt_expires_at: string;
  };
}

function defaultApiBase(): string {
  const base =
    process.env.UNCODIE_API_PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'https://api.uncodie.com';
  return base.replace(/\/$/, '');
}

/**
 * Probe the sandbox's `.env.local` for a non-empty `UNCODIE_API_KEY` entry.
 * Returns `false` when the file is missing, the key is absent, or the value
 * is an empty string. Used to decide whether to reuse the prior active key
 * (still works since we only persist its id on remote_instances) or force a
 * rotation so we can re-inject plaintext into a fresh sandbox.
 */
async function sandboxHasApiKeyEnv(sandbox: Sandbox, cwd: string): Promise<boolean> {
  try {
    const res = await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `[ -f "${cwd}/.env.local" ] && grep -E '^UNCODIE_API_KEY=.+' "${cwd}/.env.local" >/dev/null 2>&1 && echo YES || echo NO`,
      ],
    });
    const out = (await res.stdout()).toString().trim();
    return out === 'YES';
  } catch (e: unknown) {
    console.warn(
      '[provisionPlatformKeyStep] .env.local probe failed (assuming missing):',
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

async function mergeDotEnvLocal(sandbox: Sandbox, cwd: string, entries: Record<string, string>): Promise<void> {
  const lines = Object.entries(entries)
    .filter(([, v]) => typeof v === 'string' && v.length > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  if (!lines) return;
  const b64 = Buffer.from(lines + '\n', 'utf8').toString('base64');
  // Append-or-create, de-duplicating keys: prepend new values, strip prior
  // occurrences of the same keys from the existing file. This way rotating
  // the key later overwrites cleanly.
  const keysSed = Object.keys(entries)
    .filter((k) => entries[k])
    .map((k) => `/^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=/d`)
    .join(';');
  await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `cd "${cwd}" && touch .env.local && (sed -i '${keysSed}' .env.local || true) && (echo "${b64}" | base64 -d) > /tmp/_uncodie_env_add && cat /tmp/_uncodie_env_add .env.local > .env.local.next && mv .env.local.next .env.local && rm -f /tmp/_uncodie_env_add`,
    ],
  });
}

/**
 * Creates (or reuses) the Platform API key for the requirement and injects it
 * into the sandbox's `.env.local` alongside the API base URL. Must run after
 * `createSandboxStep` and before the first agent turn so the generated app
 * sees the envs when Next.js reads them at build time.
 */
export async function provisionPlatformKeyStep(
  input: ProvisionPlatformKeyStepInput,
): Promise<ProvisionPlatformKeyStepResult> {
  'use step';
  const { sandboxId, requirementId, siteId, userId, instanceId } = input;

  // The raw Platform API key is only returned once, at creation. If a prior
  // key is still active but the sandbox was recreated (fresh VM, `.env.local`
  // gone because it's in .gitignore), reusing by id alone would leave the
  // generated app with no token. Probe the sandbox first and force a rotation
  // whenever the key is not already materialised there.
  let sandboxForProbe: Sandbox | undefined;
  let needsFreshKey = false;
  try {
    sandboxForProbe = await Sandbox.get({ sandboxId });
    needsFreshKey = !(await sandboxHasApiKeyEnv(sandboxForProbe, SandboxService.WORK_DIR));
  } catch (e: unknown) {
    console.warn(
      '[provisionPlatformKeyStep] sandbox probe failed — forcing rotation to be safe:',
      e instanceof Error ? e.message : e,
    );
    needsFreshKey = true;
  }

  const result = await ensurePlatformKeyForRequirement({
    requirement_id: requirementId,
    site_id: siteId,
    user_id: userId,
    instance_id: instanceId,
    rotate: needsFreshKey,
  });

  const envInjected = !!result.api_key;
  let tenant: ProvisionPlatformKeyStepResult['tenant'];

  const envBag: Record<string, string> = {};
  if (envInjected) {
    envBag.UNCODIE_API_KEY = result.api_key;
    envBag.UNCODIE_API_BASE = input.apiBaseUrl ?? defaultApiBase();
  }

  if (input.authProvider !== null) {
    try {
      const ten = await ensureTenant({
        requirement_id: requirementId,
        site_id: siteId,
        user_id: userId,
        auth_provider: input.authProvider ?? 'supabase',
      });
      tenant = {
        tenant_id: ten.tenant_id,
        schema: ten.schema,
        bucket: ten.bucket,
        auth_provider: ten.auth_provider,
        created: ten.created,
        jwt_expires_at: ten.jwt_expires_at,
      };
      try {
        const apps = getAppsPublicConfig();
        envBag.NEXT_PUBLIC_APPS_SUPABASE_URL = apps.url;
        if (apps.anonKey) envBag.NEXT_PUBLIC_APPS_SUPABASE_ANON_KEY = apps.anonKey;
      } catch (e: unknown) {
        console.warn(
          '[provisionPlatformKeyStep] apps public config unavailable, skipping NEXT_PUBLIC_APPS_*:',
          e instanceof Error ? e.message : e,
        );
      }
      envBag.NEXT_PUBLIC_APPS_TENANT_SCHEMA = ten.schema;
      envBag.APPS_TENANT_JWT = ten.jwt;
      envBag.APPS_AUTH_PROVIDER = ten.auth_provider;
    } catch (e: unknown) {
      console.warn(
        '[provisionPlatformKeyStep] tenant provisioning failed (continuing without DB envs):',
        e instanceof Error ? e.message : e,
      );
    }
  }

  if (Object.keys(envBag).length > 0) {
    try {
      const sandbox = sandboxForProbe ?? (await Sandbox.get({ sandboxId }));
      await mergeDotEnvLocal(sandbox, SandboxService.WORK_DIR, envBag);
    } catch (e: unknown) {
      console.warn(
        '[provisionPlatformKeyStep] failed to write .env.local (continuing):',
        e instanceof Error ? e.message : e,
      );
    }
  }

  return {
    platform_key_id: result.key_id,
    created: result.created,
    expires_at: result.expires_at,
    env_injected: envInjected,
    tenant,
  };
}
