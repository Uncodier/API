import { randomUUID } from 'node:crypto';

type Client = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
export type SandboxCleanupFence = { assert(): Promise<void>; finish(): Promise<void> };

/** A durable claim, NOT an ownership read followed by a stop. The DB trigger
 * blocks control/coordinator resume until a confirmed stop releases this claim.
 * Unknown provider outcomes intentionally leave the claim for reconciliation. */
export async function claimSandboxCleanup(input: {
  sessionId: string; siteId: string; owner: string | null; resource: string; bootstrap?: boolean;
}, client?: Client): Promise<SandboxCleanupFence | null> {
  const db = client ?? (await import('@/lib/database/supabase-client')).supabaseAdmin;
  const token = randomUUID();
  const args = { p_id: input.sessionId, p_site_id: input.siteId, p_owner: input.owner,
    p_resource: input.resource, p_token: token, p_bootstrap: input.bootstrap ?? false };
  const claimed = await db.rpc('begin_harness_sandbox_cleanup', args);
  if (claimed.error) throw new Error('Sandbox cleanup claim unavailable');
  if (claimed.data !== true) return null;
  return {
    async assert() {
      const result = await db.rpc('assert_harness_sandbox_cleanup', { p_id: input.sessionId, p_site_id: input.siteId, p_token: token, p_resource: input.resource });
      if (result.error || result.data !== true) throw new Error('Sandbox cleanup claim lost');
    },
    async finish() {
      const result = await db.rpc('finish_harness_sandbox_cleanup', { p_id: input.sessionId, p_site_id: input.siteId, p_token: token });
      if (result.error || result.data !== true) throw new Error('Sandbox cleanup completion unavailable');
    },
  };
}