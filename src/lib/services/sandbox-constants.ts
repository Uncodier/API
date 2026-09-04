/**
 * Shared sandbox create / timeout / resource defaults.
 * One module so service, snapshot restore, and workflow-robot stay aligned.
 */

export const SANDBOX_WORK_DIR = '/vercel/sandbox';
export const SANDBOX_VISUAL_PROBE_PORT = 3000;

/** Session timeout on create — long enough for a cron cycle without extendTimeout dances. */
export const SANDBOX_CREATE_TIMEOUT_MS = 45 * 60 * 1000;

/** Best-effort extra lifetime after create (ignored when already at plan limit). */
export const SANDBOX_EXTEND_AFTER_CREATE_MS = 4 * 60 * 1000;

export const SANDBOX_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const NPM_LOCK_HASH_MARKER = `${SANDBOX_WORK_DIR}/.npm-lock-hash`;

export function sandboxVcpus(): number {
  const raw = Number(process.env.SANDBOX_VCPUS);
  if (Number.isFinite(raw) && raw >= 1) return raw;
  return 2;
}

export function requirementSandboxName(requirementId: string, instanceId?: string | null): string {
  const req = String(requirementId || '').replace(/[^a-f0-9-]/gi, '').slice(0, 8);
  const inst = instanceId
    ? String(instanceId).replace(/[^a-f0-9-]/gi, '').slice(0, 8)
    : 'na';
  return `req-${req}-${inst}`.toLowerCase();
}

export function sandboxBaseName(kind: 'applications' | 'automation'): string {
  return kind === 'automation' ? 'makinari-automations-base' : 'makinari-apps-base';
}
