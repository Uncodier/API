import { randomUUID } from 'node:crypto';
import { createDeliveryTools } from '@/lib/harness/delivery-tools';
import type { SessionScope, Workspace } from '@/lib/harness/types';
import { resolveHostProfile, type HostProfile } from '@/lib/harness/profile';

/** Adapter only: reuse the existing remote deploy tools without opening a VM. */
export function createAssistantDeploymentTools(scope: SessionScope, instanceId: string, assertActive: () => Promise<void>,
  options: { env?: NodeJS.ProcessEnv; request?: typeof fetch } = {}) {
  const env = options.env ?? process.env;
  let profile: Pick<HostProfile, 'allowed' | 'deployment'> = { allowed: ['deployment_trigger', 'deployment_status'] };
  const token = env.VERCEL_TOKEN || env.VERCEL_ACCESS_TOKEN;
  if (token && env.APPS_VERCEL_PROJECT_ID) {
    profile.deployment = { projectId: env.APPS_VERCEL_PROJECT_ID, token, teamId: env.VERCEL_TEAM_ID };
  }
  const raw = JSON.parse(env.HARNESS_V2_PROFILES || '{}');
  const matches = Object.entries(raw).filter(([, value]) => {
    const entry = value as HostProfile;
    return entry?.siteId === scope.siteId && entry?.userId === scope.userId && !entry.requirementId && entry.deployment;
  });
  if (matches.length > 1) throw new Error('Assistant deployment host profile is ambiguous');
  if (matches.length === 1) {
    const [name, value] = matches[0];
    profile = resolveHostProfile(name, scope.siteId, (value as HostProfile).repositoryUrl, env)!;
  }
  const workspace = { ref: { provider: 'vercel', id: instanceId, root: '/vercel/sandbox' } } as Workspace;
  return createDeliveryTools({ scope, workspace, profile, request: options.request })
    .filter(tool => ['deployment_trigger', 'deployment_status'].includes(tool.name))
    .map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
      execute: async (input: Record<string, unknown>) => {
        const { thought_process: _thought, ...args } = input;
        return tool.execute(args, { sessionId: instanceId, operationId: randomUUID(),
          signal: AbortSignal.timeout(30000), assertActive });
      } }));
}