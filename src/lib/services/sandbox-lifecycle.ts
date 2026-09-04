import { Sandbox } from '@vercel/sandbox';
import { getSandboxHandle, sandboxSdkMajor } from '@/lib/services/sandbox-sdk';
import { stopSandboxQuiet } from '@/lib/services/sandbox-stop';
import { requirementSandboxName } from '@/lib/services/sandbox-constants';
import { supabaseAdmin } from '@/lib/database/supabase-client';

/**
 * Terminal cleanup: delete the named sandbox and its leftover snapshots.
 * Used when a requirement is done / cancelled — not on the happy-path stop.
 */
export async function deleteSandboxAndOrphans(idOrName: string): Promise<void> {
  const id = String(idOrName || '').trim();
  if (!id) return;
  try {
    const sandbox = await getSandboxHandle(id);
    const del = (sandbox as Sandbox & { delete?: (opts?: { deleteOrphanSnapshots?: boolean }) => Promise<void> }).delete;
    if (typeof del === 'function') {
      await del.call(sandbox, { deleteOrphanSnapshots: true });
      return;
    }
    await stopSandboxQuiet(sandbox);
  } catch (e: unknown) {
    console.warn(
      `[Sandbox] deleteSandboxAndOrphans skipped for ${id}:`,
      e instanceof Error ? e.message : e,
    );
  }
}

/** Delete the named sandbox(es) for a requirement that is done or cancelled. */
export async function deleteRequirementSandboxes(
  requirementId: string,
  instanceId?: string | null,
  extraIds?: Array<string | null | undefined>,
): Promise<void> {
  const ids = new Set<string>();
  ids.add(requirementSandboxName(requirementId, instanceId));
  if (instanceId) ids.add(requirementSandboxName(requirementId, null));
  for (const extra of extraIds || []) {
    if (extra?.trim()) ids.add(extra.trim());
  }
  try {
    const { data } = await supabaseAdmin
      .from('requirement_status')
      .select('active_sandbox_id')
      .eq('requirement_id', requirementId)
      .not('active_sandbox_id', 'is', null)
      .limit(8);
    for (const row of data || []) {
      const id = (row as { active_sandbox_id?: string }).active_sandbox_id;
      if (id) ids.add(id);
    }
  } catch {
    /* best-effort lookup */
  }
  for (const id of ids) {
    await deleteSandboxAndOrphans(id);
  }
}

export function shouldTakeManualEndOfWorkflowSnapshot(): boolean {
  // v3 stop() already snapshots (keepLastSnapshots count=1). Extra snapshot()
  // would pause the session and briefly keep two copies.
  return sandboxSdkMajor() < 3;
}
