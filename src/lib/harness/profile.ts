import { z } from 'zod';

const profileSchema = z.object({
  siteId: z.string().uuid(),
  userId: z.string().uuid(),
  repositoryUrl: z.string().url(),
  allowed: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(50).default([]),
  requirementId: z.string().uuid().optional(),
  git: z.object({ username: z.string().min(1), password: z.string().min(1), allowPush: z.boolean().default(false) }).strict().optional(),
  environment: z.record(z.string()).default({}),
  deployment: z.object({ projectId: z.string().min(1).max(200), teamId: z.string().min(1).max(200).optional(),
    token: z.string().min(1), deployHookUrl: z.string().url().optional() }).strict().optional(),
}).strict();

export type HostProfile = z.infer<typeof profileSchema>;

/** Only the server can provision profiles. Client/model inputs select a scoped name, never values. */
export function resolveHostProfile(name: string | undefined, siteId: string, repositoryUrl: string,
  env: NodeJS.ProcessEnv = process.env): HostProfile | undefined {
  if (!name) return;
  let raw: unknown;
  try { raw = JSON.parse(env.HARNESS_V2_PROFILES || '{}'); }
  catch { throw new Error('Harness host profiles are not configured correctly'); }
  const profiles = z.record(z.unknown()).parse(raw);
  if (!Object.hasOwn(profiles, name)) throw new Error('Harness profile unavailable');
  const parsed = profileSchema.safeParse(profiles[name]);
  if (!parsed.success) throw new Error('Harness profile configuration is invalid');
  const profile = parsed.data;
  if (profile.siteId !== siteId || profile.repositoryUrl !== repositoryUrl) throw new Error('Harness profile does not authorize this site and repository');
  // A bound legacy resource must have exactly one profile name, so the database
  // session/profile uniqueness constraint also serializes that resource.
  if (profile.requirementId && Object.entries(profiles).some(([key, value]) => key !== name &&
    value && typeof value === 'object' && 'requirementId' in value && value.requirementId === profile.requirementId)) {
    throw new Error('A requirement must not be shared by multiple harness profiles');
  }
  // Never propagate control-plane credentials via configurable runtime environment.
  const forbidden = /(?:SERVICE_ROLE|SERVICE_API_KEY|OPENROUTER_API_KEY|VERCEL_(?:TOKEN|OIDC_TOKEN)|GITHUB_TOKEN|ENCRYPTION_KEY|CRON_SECRET)/i;
  if (Object.keys(profile.environment).some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || forbidden.test(name))) {
    throw new Error('Control-plane secrets cannot be supplied to a harness runtime');
  }
  return profile;
}