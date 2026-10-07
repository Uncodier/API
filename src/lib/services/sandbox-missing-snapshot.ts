import { APIError, Sandbox } from '@vercel/sandbox';

/** Older Sandbox endpoints return 400/bad_request rather than 410/snapshot_not_found. */
export function isMissingSandboxSnapshotError(error: unknown): boolean {
  const data = error instanceof APIError
    ? error.json as { error?: { code?: string; message?: string } } | undefined
    : undefined;
  return error instanceof APIError &&
    ((error.response.status === 400 && data?.error?.code === 'bad_request' &&
      data.error.message === 'Cannot resume sandbox: no snapshot available.') ||
      (error.response.status === 410 && data?.error?.code === 'snapshot_not_found'));
}

export function isSandboxNotFoundError(error: unknown): boolean {
  const data = error instanceof APIError
    ? error.json as { error?: { code?: string } } | undefined : undefined;
  return error instanceof APIError && error.response.status === 404 && data?.error?.code === 'not_found';
}

/**
 * Release only a verified, stopped named shell with no remaining snapshots.
 * Never infer data loss from a timeout, auth failure or failed workspace callback.
 * The caller must hold execution ownership and rebuild from the normal Git/spec
 * pipeline; this is not evidence that uncommitted workspace bytes were recovered.
 */
export async function retireSandboxWithoutSnapshots(
  name: string,
  assertOwnership: () => Promise<void>,
): Promise<void> {
  await assertOwnership();
  const sandbox = await Sandbox.get({ name, resume: false });
  if (sandbox.name !== name || sandbox.status !== 'stopped') {
    throw new Error('Missing-snapshot recovery refused: sandbox is not stopped');
  }
  const [snapshots, sessions] = await Promise.all([
    sandbox.listSnapshots({ limit: 50 }),
    sandbox.listSessions({ limit: 50 }),
  ]);
  const terminal = new Set(['stopped', 'failed', 'aborted']);
  if (snapshots.snapshots.length || snapshots.pagination.next ||
    sessions.pagination.next || sessions.sessions.some(session => !terminal.has(session.status))) {
    throw new Error('Missing-snapshot recovery refused: snapshots or active sessions remain');
  }
  // Re-read after inspection: a concurrent resume or snapshot update denies deletion.
  const current = await Sandbox.get({ name, resume: false });
  if (current.name !== name || current.status !== 'stopped' ||
    current.createdAt.getTime() !== sandbox.createdAt.getTime() ||
    current.currentSnapshotId !== sandbox.currentSnapshotId ||
    current.statusUpdatedAt?.getTime() !== sandbox.statusUpdatedAt?.getTime()) {
    throw new Error('Missing-snapshot recovery refused: sandbox changed during inspection');
  }
  // Do not request orphan deletion. No accessible snapshot/workspace is discarded.
  await assertOwnership();
  await current.delete({ deleteOrphanSnapshots: false });
}