import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { uploadSandboxSourceArchiveToRepository } from '@/app/api/agents/tools/sandbox/sandbox-source-upload';
import { patchLatestRequirementStatusColumns } from '@/app/api/cron/shared/cron-commit-helpers';

const WORK_DIR = SandboxService.WORK_DIR;

import { liveSandbox, type SandboxToolsContext, deductSandboxToolCredits } from '@/app/api/agents/tools/sandbox/assistantProtocol';

/** Subject lines we treat as automated / pushed checkpoints (see sandbox_push_checkpoint & cron-commit-helpers). */
export function isLikelyCheckpointSubject(subject: string): boolean {
  return /\[checkpoint\]/i.test(subject) || /^WIP:\s*step\b/i.test(subject.trim());
}

export type SandboxCheckpointRow = {
  short_sha: string;
  full_sha: string;
  subject: string;
  date_iso: string;
  is_checkpoint: boolean;
};

export async function listCommitsInSandbox(
  sandbox: Sandbox,
  limit: number,
): Promise<{ branch: string; commits: SandboxCheckpointRow[] }> {
  const branchRes = await sandbox.runCommand({ cmd: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: WORK_DIR });
  const branch =
    branchRes.exitCode === 0 ? (await branchRes.stdout()).trim() : '(unknown)';

  const cap = Math.min(Math.max(limit, 5), 80);
  const logRes = await sandbox.runCommand({
    cmd: 'git',
    args: ['log', `-${cap}`, '--format=%H\t%s\t%ci'],
    cwd: WORK_DIR,
  });
  if (logRes.exitCode !== 0) {
    throw new Error(`git log failed: ${await logRes.stderr()}`);
  }

  const text = (await logRes.stdout()).trim();
  const commits: SandboxCheckpointRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    const tab2 = line.indexOf('\t', tab + 1);
    if (tab < 0 || tab2 < 0) continue;
    const full_sha = line.slice(0, tab);
    const subject = line.slice(tab + 1, tab2);
    const date_iso = line.slice(tab2 + 1);
    commits.push({
      full_sha,
      short_sha: full_sha.slice(0, 7),
      subject,
      date_iso,
      is_checkpoint: isLikelyCheckpointSubject(subject),
    });
  }
  return { branch, commits };
}

export function sandboxRestoreCheckpointTool(sandbox: Sandbox, requirementId?: string, toolsCtx?: SandboxToolsContext) {
  const instanceId = toolsCtx?.instance_id;
  return {
    name: 'sandbox_restore_checkpoint',
    description:
      'List or restore git state inside the Vercel Sandbox only (does not change GitHub). Use action=list to see recent commits on the current branch with checkpoint labels; use action=restore with commit_sha to reset the workspace to that commit (git reset --hard). Destructive: uncommitted changes are discarded unless force=true. After a successful restore, the current tree is uploaded to Supabase Storage (same archive as checkpoints) when requirement_id is in context. Pair with sandbox_push_checkpoint after fixing if you need origin updated.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'restore'],
          description: 'list: enumerate commits on the current branch. restore: move HEAD and working tree to commit_sha.',
        },
        commit_sha: {
          type: 'string',
          description:
            'Full or short commit hash. Required when action is restore. Pick a value from a prior list result.',
        },
        limit: {
          type: 'number',
          description: 'Max commits to return when action=list (default 30, max 80).',
        },
        force: {
          type: 'boolean',
          description:
            'When true, allow restore even if the working tree has uncommitted changes. Default false.',
        },
      },
      required: ['action'],
    },
    execute: async (args: {
      action: 'list' | 'restore';
      commit_sha?: string;
      limit?: number;
      force?: boolean;
    }) => {
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_restore_checkpoint', args);
      if (!creditCheck.success) {
        return { ok: false, error: creditCheck.error };
      }

      const s0 = liveSandbox(sandbox, toolsCtx);
      try {
        await s0.extendTimeout(2 * 60 * 1000);
      } catch {
        /* ignore */
      }

      const limit = args.limit ?? 30;

      if (args.action === 'list') {
        const { branch, commits } = await listCommitsInSandbox(s0, limit);
        const checkpointCommits = commits.filter((c) => c.is_checkpoint);
        return {
          ok: true,
          branch,
          commit_count: commits.length,
          checkpoint_commits: checkpointCommits,
          commits,
          hint: 'Use action=restore with commit_sha from commits[].full_sha or short_sha to rewind the sandbox only.',
        };
      }

      const sha = args.commit_sha?.trim();
      if (!sha) {
        return {
          ok: false,
          error: 'commit_sha is required when action is restore.',
        };
      }

      if (!args.force) {
        const st = await s0.runCommand({ cmd: 'git', args: ['status', '--porcelain'], cwd: WORK_DIR });
        if (st.exitCode === 0 && (await st.stdout()).trim().length > 0) {
          return {
            ok: false,
            error:
              'Working tree has uncommitted changes. Commit/stash, or pass force=true to discard them and restore.',
          };
        }
      }

      const verify = await s0.runCommand({
        cmd: 'git',
        args: ['rev-parse', '--verify', `${sha}^{commit}`],
        cwd: WORK_DIR,
      });
      if (verify.exitCode !== 0) {
        return {
          ok: false,
          error: `Invalid or unknown commit: ${sha}. ${(await verify.stderr()).trim()}`,
        };
      }
      const fullSha = (await verify.stdout()).trim();

      const reset = await s0.runCommand({ cmd: 'git', args: ['reset', '--hard', fullSha], cwd: WORK_DIR });
      if (reset.exitCode !== 0) {
        return {
          ok: false,
          error: `git reset --hard failed: ${(await reset.stderr()).trim()}`,
        };
      }

      const head = await s0.runCommand({ cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: WORK_DIR });
      const base = {
        ok: true as const,
        restored_to: fullSha,
        short_sha: head.exitCode === 0 ? (await head.stdout()).trim() : fullSha.slice(0, 7),
        message:
          'Sandbox repo reset to that commit. Remote (origin) was not changed — push again with sandbox_push_checkpoint if needed.',
      };

      if (requirementId?.trim()) {
        const rid = requirementId.trim();
        const up = await uploadSandboxSourceArchiveToRepository(s0, rid);
        if (up.ok) {
          const pr = await patchLatestRequirementStatusColumns({
            requirementId: rid,
            instanceId,
            columns: { source_code: up.public_url },
          });
          return {
            ...base,
            source_archive_url: up.public_url,
            source_archive_file: up.file,
            source_archive_bytes: up.size_bytes,
            requirement_status_updated: pr.updated,
          };
        }
        return {
          ...base,
          source_upload_error: up.error,
        };
      }

      return base;
    },
  };
}
