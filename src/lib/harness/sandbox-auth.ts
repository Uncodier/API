/** Sandbox control-plane credentials. Never place these in a profile, session or VM environment. */
export interface SandboxAccessCredentials { token: string; teamId: string; projectId: string }

export class SandboxAuthConfigurationError extends Error {
  constructor() {
    super('Sandbox access-token authentication requires a complete host token, team ID and project ID. Configure HARNESS_SANDBOX_AUTH or use Vercel OIDC.');
    this.name = 'SandboxAuthConfigurationError';
  }
}

/** Keep managed OIDC as default; never silently replace it with a broader PAT.
 * An operator can explicitly select access-token mode for a non-OIDC host.
 * No interactive login, project inference, filesystem credentials or auth fallback.
 */
export function resolveSandboxAuth(env: Record<string, string | undefined> = process.env): Partial<SandboxAccessCredentials> {
  const mode = env.HARNESS_SANDBOX_AUTH || 'oidc';
  if (mode === 'oidc') return {};
  if (mode !== 'access-token') throw new SandboxAuthConfigurationError();
  const values = {
    token: env.HARNESS_SANDBOX_TOKEN ?? env.VERCEL_TOKEN,
    teamId: env.HARNESS_SANDBOX_TEAM_ID ?? env.VERCEL_TEAM_ID,
    projectId: env.HARNESS_SANDBOX_PROJECT_ID ?? env.VERCEL_PROJECT_ID,
  };
  if (Object.values(values).some(value => typeof value !== 'string' || !value.trim() ||
    /[\x00-\x20\x7f]/.test(value) || value.length > 8192)) throw new SandboxAuthConfigurationError();
  return values as SandboxAccessCredentials;
}