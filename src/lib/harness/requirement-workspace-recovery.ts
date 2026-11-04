import { adoptRequirementWorkspace, openWorkspace, shellQuote } from './workspace';
import type { Workspace } from './types';

type OpenInput = Parameters<typeof openWorkspace>[0];

/** Only call for a fresh/reprovisioned checkout; never switch an adopted dirty tree. */
export async function selectRequirementBranch(workspace: Workspace, branch: string, signal?: AbortSignal): Promise<void> {
  const git = 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false';
  const command = `if ${git} show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}; then ${git} switch ${shellQuote(branch)}; elif ${git} show-ref --verify --quiet ${shellQuote(`refs/remotes/origin/${branch}`)}; then ${git} switch --track ${shellQuote(`origin/${branch}`)}; else ${git} switch -c ${shellQuote(branch)}; fi`;
  const result = await workspace.exec({ command, timeoutMs: 10000 }, signal);
  if (result.exitCode !== 0) throw new Error('Could not select requirement work branch without overwriting work');
}

/** Reuse existing work first. A confirmed GET 404 alone authorizes a fresh,
 * session-scoped clone through the normal billing/bootstrap/isolation path.
 * No delete/reset, alternate provider credentials, or provider-write retry. */
export async function openRequirementWorkspace(input: OpenInput & {
  assertActive(): Promise<void>;
  existingWorkspace?: string;
  previousSessionId?: string;
}, dependencies = { adopt: adoptRequirementWorkspace, open: openWorkspace }) {
  const { existingWorkspace, previousSessionId, ...opening } = input;
  if (!existingWorkspace) return { workspace: await dependencies.open(opening), selectBranch: true };
  try {
    const workspace = await dependencies.adopt({ ...opening, workspaceId: existingWorkspace,
      previousSessionId, assertActive: opening.assertActive });
    // A canonical VM whose reference was never saved can be a replacement that
    // finished bootstrap but failed before branch selection/status persistence.
    // No model work has been admitted on that new reference yet.
    return { workspace, selectBranch: !opening.existing && existingWorkspace === `h-${opening.sessionId.toLowerCase()}` };
  } catch (error) {
    if (!(error instanceof Error) || (error as Error & { code?: string }).code !== 'WORKSPACE_NOT_FOUND') throw error;
    input.signal?.throwIfAborted();
    await input.assertActive();
    if (input.siteId && !input.onMissingWorkspace) throw new Error('Missing workspace recovery requires a durable host callback.');
    await input.onMissingWorkspace?.(existingWorkspace);
    await input.assertActive();
    // The old ref may use a legacy name. New resources use h-<session>, preserving
    // billing ownership and deterministic discovery after an interrupted bootstrap.
    const workspace = await dependencies.open({ ...opening, existing: undefined });
    return { workspace, selectBranch: true, recoveredFrom: existingWorkspace };
  }
}