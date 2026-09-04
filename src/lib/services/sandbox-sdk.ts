import { Sandbox } from '@vercel/sandbox';
import { requirementSandboxName } from '@/lib/services/sandbox-constants';

export function sandboxSdkMajor(): number {
  try {
    // v2/v3 expose getOrCreate; v1 does not.
    return typeof (Sandbox as unknown as { getOrCreate?: unknown }).getOrCreate === 'function' ? 3 : 1;
  } catch {
    return 1;
  }
}

export function sandboxIdentity(sandbox: Sandbox): string {
  const anyS = sandbox as Sandbox & { name?: string; sandboxId?: string };
  return String(anyS.name || anyS.sandboxId || '');
}

/**
 * Retrieve a sandbox by persisted id. v1 uses sandboxId; v3 backfills that
 * value as `name`, so we try name first then sandboxId.
 */
export async function getSandboxHandle(idOrName: string): Promise<Sandbox> {
  const id = String(idOrName || '').trim();
  if (!id) throw new Error('Sandbox id/name is required');

  const getFn = Sandbox.get.bind(Sandbox) as (opts: Record<string, unknown>) => Promise<Sandbox>;
  if (sandboxSdkMajor() >= 3) {
    try {
      return await getFn({ name: id });
    } catch {
      return await getFn({ sandboxId: id });
    }
  }
  try {
    return await getFn({ sandboxId: id });
  } catch {
    return await getFn({ name: id });
  }
}

export function namedSandboxOpts(requirementId: string, instanceId?: string | null): { name: string } {
  return { name: requirementSandboxName(requirementId, instanceId) };
}
