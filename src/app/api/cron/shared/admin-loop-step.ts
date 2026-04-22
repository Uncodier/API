'use step';

import { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { detectAdminLoop, type CycleGitChange, type LoopDetectorVerdict } from './loop-detectors';

export interface DetectAdminLoopStepInput {
  sandboxId: string;
  /** How many recent commits to inspect. Defaults to 4 (the detector slices the last 2). */
  cycles?: number;
}

/**
 * Inspects recent commits in the sandbox repo and returns the admin-loop
 * verdict. Used by the workflow to flag the active backlog item as
 * `needs_review` when 2 consecutive cycles only touched docs / evidence
 * files and to force a scope downgrade in the next cycle.
 */
export async function detectAdminLoopStep(input: DetectAdminLoopStepInput): Promise<LoopDetectorVerdict> {
  'use step';
  const cycles = Math.max(2, Math.min(10, input.cycles ?? 4));
  let history: CycleGitChange[] = [];

  try {
    const sandbox = await Sandbox.get({ sandboxId: input.sandboxId });
    const cwd = SandboxService.WORK_DIR;
    const result = await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `cd "${cwd}" && git log -${cycles} --pretty=format:'__COMMIT__%H' --name-only 2>/dev/null || true`,
      ],
    });
    const stdout = await result.stdout();
    history = parseGitNameOnlyLog(stdout);
  } catch (e: unknown) {
    console.warn('[admin-loop-step] git log failed (returning neutral verdict):', e instanceof Error ? e.message : e);
    return { triggered: false, kind: 'admin', metrics: { cycles_inspected: 0 } };
  }

  return detectAdminLoop(history);
}

function parseGitNameOnlyLog(raw: string): CycleGitChange[] {
  const out: CycleGitChange[] = [];
  let current: CycleGitChange | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('__COMMIT__')) {
      if (current) out.push(current);
      current = { files: [] };
      continue;
    }
    if (!current) {
      current = { files: [] };
    }
    current.files.push(trimmed);
  }
  if (current) out.push(current);
  return out;
}
