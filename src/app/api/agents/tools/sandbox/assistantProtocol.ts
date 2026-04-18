import { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import {
  commitWorkspaceToOrigin,
  syncLatestRequirementStatusWithPreview,
  patchLatestRequirementStatusColumns,
  repoNameForGitRepoKind,
  type GitRepoKind,
} from '@/app/api/cron/shared/cron-commit-helpers';
import { sandboxRestoreCheckpointTool } from '@/app/api/agents/tools/sandbox/sandbox-checkpoint-restore';
import { uploadSandboxSourceArchiveToRepository } from '@/app/api/agents/tools/sandbox/sandbox-source-upload';
import { skillLookupTool } from '@/app/api/agents/tools/sandbox/skill-lookup-tool';

const WORK_DIR = SandboxService.WORK_DIR;

function resolvePath(inputPath: string | undefined, defaultPath: string): string {
  if (!inputPath) return defaultPath;
  if (inputPath.startsWith('/')) return inputPath;
  return `${defaultPath}/${inputPath}`.replace(/\/+/g, '/');
}

/**
 * This monorepo uses Next.js with `src/app` (App Router). Models often write `app/...` or
 * `app/src/app/...` at the repo root (docs say "app directory"), producing invalid trees like
 * `app/src/app/prd` that do not compile on Vercel. Remap to the real paths.
 */
export function normalizeSandboxFsPath(workDir: string, resolved: string): string {
  const WD = workDir.replace(/\/+$/, '');
  if (!resolved.startsWith(`${WD}/`)) return resolved;

  const myApp = `${WD}/my-app/`;
  const frontend = `${WD}/frontend/`;
  for (const bad of [myApp, frontend]) {
    const n = resolved.startsWith(bad) ? `${WD}/${resolved.slice(bad.length)}` : null;
    if (n) {
      console.warn(`[WriteGuard] Nested project dir: ${resolved} → ${n}`);
      return n;
    }
  }

  // app/src/app/... → src/app/... (most common bad merge of "app" + "src/app")
  const doubleApp = `${WD}/app/src/app/`;
  if (resolved.startsWith(doubleApp)) {
    const n = `${WD}/src/app/${resolved.slice(doubleApp.length)}`;
    console.warn(`[WriteGuard] app/src/app → src/app: ${resolved} → ${n}`);
    return n;
  }

  const appRoot = `${WD}/app/`;
  if (!resolved.startsWith(appRoot)) return resolved;

  const rest = resolved.slice(appRoot.length);
  if (!rest || rest.startsWith('node_modules') || rest.startsWith('.')) return resolved;

  // app/public/... → public/... (root public folder)
  if (rest.startsWith('public/')) {
    const n = `${WD}/${rest}`;
    console.warn(`[WriteGuard] app/public → public: ${resolved} → ${n}`);
    return n;
  }

  // app/src/... (not app/src/app/) → src/...
  if (rest.startsWith('src/')) {
    const n = `${WD}/${rest}`;
    console.warn(`[WriteGuard] app/src → src: ${resolved} → ${n}`);
    return n;
  }

  // app/<route>/... → src/app/<route>/...
  const n = `${WD}/src/app/${rest}`;
  console.warn(`[WriteGuard] root app/ → src/app: ${resolved} → ${n}`);
  return n;
}

export type SandboxToolsContext = {
  site_id?: string;
  instance_id?: string;
  git_repo_kind?: GitRepoKind;
  /** Narrows skill_lookup list/search to skills whose types match this requirement. */
  requirement_type?: string;
  /** When set (cron executor), sandbox_push_checkpoint updates this plan step for auditing */
  plan_id?: string;
  active_step_id?: string;
};

export function sandboxRunCommandTool(sandbox: Sandbox) {
  return {
    name: 'sandbox_run_command',
    description: `Execute a shell command inside the Vercel Sandbox microVM. The default working directory is ${WORK_DIR} which contains the cloned repository.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run (e.g., "npm", "ls", "git")' },
        args: { type: 'array', items: { type: 'string' }, description: 'Array of arguments for the command' },
        cwd: { type: 'string', description: `Optional working directory. Defaults to ${WORK_DIR}` }
      },
      required: ['command']
    },
    execute: async (args: { command: string, args?: string[], cwd?: string }) => {
      const fullCmd = [args.command, ...(args.args || [])].join(' ');
      const blocked = /create-next-app|create-react-app|create-vite|npm init|yarn init|pnpm init/i;
      if (blocked.test(fullCmd)) {
        return {
          stdout: '',
          stderr: 'BLOCKED: Scaffolding commands are forbidden. The project already exists at the repository root. Write files directly instead.',
          exitCode: 1,
        };
      }
      return SandboxService.runCommandInSandbox(sandbox, args.command, args.args || [], resolvePath(args.cwd, WORK_DIR));
    }
  };
}

export function sandboxWriteFileTool(sandbox: Sandbox) {
  return {
    name: 'sandbox_write_file',
    description: 'Write or overwrite a file in the Vercel Sandbox filesystem.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: `File path relative to ${WORK_DIR} (e.g. "src/app/foo/page.tsx") or absolute. Use src/app/ for routes — do NOT use a top-level app/ folder; the tool will remap mistaken app/ paths to src/app/.`,
        },
        content: { type: 'string', description: 'Content to write to the file' }
      },
      required: ['path', 'content']
    },
    execute: async (args: { path: string, content: string }) => {
      let resolved = resolvePath(args.path, WORK_DIR);
      resolved = normalizeSandboxFsPath(WORK_DIR, resolved);

      const parentDir = resolved.includes('/')
        ? resolved.slice(0, resolved.lastIndexOf('/'))
        : WORK_DIR;
      if (parentDir) {
        await sandbox.fs.mkdir(parentDir, { recursive: true });
      }
      await sandbox.writeFiles([{ path: resolved, content: args.content }]);
      return { success: true, path: resolved };
    }
  };
}

export function sandboxReadFileTool(sandbox: Sandbox) {
  return {
    name: 'sandbox_read_file',
    description: 'Read the contents of a file from the Vercel Sandbox filesystem.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Absolute path to the file, e.g. ${WORK_DIR}/package.json` }
      },
      required: ['path']
    },
    execute: async (args: { path: string }) => {
      const resolved = normalizeSandboxFsPath(WORK_DIR, resolvePath(args.path, WORK_DIR));
      try {
        const content = await sandbox.fs.readFile(resolved, 'utf8');
        return { content };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to read file: ${msg}`);
      }
    }
  };
}

export function sandboxListFilesTool(sandbox: Sandbox) {
  return {
    name: 'sandbox_list_files',
    description: 'List files and directories in the Vercel Sandbox filesystem.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Absolute path to the directory, defaults to ${WORK_DIR}` }
      }
    },
    execute: async (args: { path?: string }) => {
      const dir = normalizeSandboxFsPath(WORK_DIR, resolvePath(args.path, WORK_DIR));
      const result = await sandbox.runCommand('ls', ['-la', dir]);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to list files: ${await result.stderr()}`);
      }
      return { files: await result.stdout() };
    }
  };
}

/**
 * Commits and pushes workspace to origin using the same path as automated cron checkpoints
 * (layout fixes, feature branch from main, etc.).
 */
export function sandboxPushCheckpointTool(
  sandbox: Sandbox,
  requirementId?: string,
  toolsCtx?: SandboxToolsContext,
) {
  return {
    name: 'sandbox_push_checkpoint',
    description:
      'REQUIRED for executor agents each plan step when the repo was modified: commit and push to origin on the requirement feature branch (same as automated cron checkpoints). After upload, updates the latest/active requirement_status row in one write with repo_url, preview_url (when resolved), and source_code (archive URL). Call after npm run build passes or when edits are ready — do not end the step without calling this at least once (unless nothing changed). Prefer over raw git push via sandbox_run_command. Requires requirement_id in sandbox context.',
    parameters: {
      type: 'object',
      properties: {
        title_hint: {
          type: 'string',
          description:
            'Short label for branch naming when creating from main (e.g. current step title). Defaults to "checkpoint".',
        },
        message: {
          type: 'string',
          description: 'Optional note for the commit message (shown in git history).',
        },
      },
    },
    execute: async (args: { title_hint?: string; message?: string }) => {
      if (!requirementId?.trim()) {
        return {
          ok: false,
          pushed: false,
          branch: '',
          error: 'requirement_id is missing in sandbox context; cannot push to origin.',
        };
      }
      const title = (args.title_hint && args.title_hint.trim()) || 'checkpoint';
      const label = args.message?.trim() ? args.message.trim() : `checkpoint ${title}`;
      const checkpointAudit =
        toolsCtx?.site_id != null
          ? {
              siteId: toolsCtx.site_id,
              instanceId: toolsCtx.instance_id,
              requirementId,
            }
          : undefined;
      try {
        const result = await commitWorkspaceToOrigin(
          sandbox,
          title,
          requirementId,
          `[checkpoint] ${label}`,
          checkpointAudit,
          {
            gitRepoKind: toolsCtx?.git_repo_kind,
            deferRequirementStatusPersist: true,
          },
        );
        let sync: Awaited<ReturnType<typeof syncLatestRequirementStatusWithPreview>> | null =
          result.requirementStatusSync ?? null;
        if (result.branch != null && sync == null) {
          sync = await syncLatestRequirementStatusWithPreview({
            requirementId,
            branch: result.branch,
            siteId: toolsCtx?.site_id,
            instanceId: toolsCtx?.instance_id,
            gitRepoKind: toolsCtx?.git_repo_kind,
            persist: false,
          });
        }
        const hint =
          !result.pushed && (result.branch === 'main' || result.branch === 'master')
            ? ' You may still be on the default branch with nothing to push — make edits on the feature branch or call again after changes.'
            : '';
        const sourceArchive = await uploadSandboxSourceArchiveToRepository(sandbox, requirementId);

        const gitOrg = process.env.GIT_ORG || 'makinary';
        const rk = toolsCtx?.git_repo_kind ?? 'applications';
        const appsRepoName = repoNameForGitRepoKind(rk);
        const fallbackRepoUrl =
          result.branch != null && String(result.branch).trim() !== ''
            ? `https://github.com/${gitOrg}/${appsRepoName}/tree/${encodeURIComponent(result.branch)}`
            : undefined;

        const cols: Partial<Record<'repo_url' | 'preview_url' | 'source_code', string>> = {};
        if (sync?.repo_url || fallbackRepoUrl) {
          cols.repo_url = (sync?.repo_url || fallbackRepoUrl) as string;
        }
        if (sync?.preview_url) cols.preview_url = sync.preview_url;
        if (sourceArchive.ok) cols.source_code = sourceArchive.public_url;

        let statusPatched = false;
        let statusRowCreated = false;
        let statusPatchError: string | undefined;
        if (Object.keys(cols).length > 0) {
          const pr = await patchLatestRequirementStatusColumns({
            requirementId,
            siteId: toolsCtx?.site_id,
            instanceId: toolsCtx?.instance_id,
            columns: cols,
          });
          statusPatched = pr.updated;
          statusRowCreated = pr.created ?? false;
          statusPatchError = pr.error;
        }

        const previewNote =
          cols.preview_url != null
            ? ` preview_url → requirement_status: ${cols.preview_url}`
            : cols.repo_url
              ? ' repo_url refreshed on requirement_status (preview pending or unavailable).'
              : '';
        const sourceNote =
          sourceArchive?.ok === true
            ? ` source_code archive → requirement_status: ${sourceArchive.public_url}`
            : sourceArchive?.ok === false
              ? ` Source archive upload skipped/failed: ${sourceArchive.error}`
              : '';
        const patchNote = statusPatched
          ? statusRowCreated
            ? ' New requirement_status row created with deliverables.'
            : ' Deliverables row updated.'
          : statusPatchError
            ? ` requirement_status not saved: ${statusPatchError}`
            : '';

        if (toolsCtx?.plan_id && toolsCtx?.active_step_id && toolsCtx?.site_id) {
          try {
            const { data: planRow } = await supabaseAdmin
              .from('instance_plans')
              .select('steps')
              .eq('id', toolsCtx.plan_id)
              .single();
            const steps = (planRow?.steps as any[]) || [];
            const cur = steps.find((s: any) => s.id === toolsCtx.active_step_id);
            const nextCount = (cur?.checkpoint_tool_calls ?? 0) + 1;
            await updateInstancePlanCore({
              plan_id: toolsCtx.plan_id,
              site_id: toolsCtx.site_id,
              instance_id: toolsCtx.instance_id,
              steps: [
                {
                  id: toolsCtx.active_step_id,
                  checkpoint_tool_calls: nextCount,
                  checkpoint_tool_invoked_at: new Date().toISOString(),
                },
              ],
            });
          } catch (trackErr) {
            console.warn('[sandbox_push_checkpoint] step tracking failed:', trackErr);
          }
        }

        return {
          ok: result.pushed,
          pushed: result.pushed,
          branch: result.branch,
          requirement_status_updated: statusPatched,
          requirement_status_created: statusRowCreated,
          ...(statusPatchError ? { requirement_status_error: statusPatchError } : {}),
          preview_url: sync?.preview_url ?? null,
          repo_url: sync?.repo_url,
          ...(sourceArchive?.ok === true
            ? {
                source_archive_url: sourceArchive.public_url,
                source_archive_file: sourceArchive.file,
                source_archive_bytes: sourceArchive.size_bytes,
              }
            : sourceArchive?.ok === false
              ? { source_upload_error: sourceArchive.error }
              : {}),
          message: result.pushed
            ? `Pushed to origin on branch "${result.branch}".${previewNote}${sourceNote}${patchNote}`
            : `No push performed (clean tree in sync, or could not publish). branch=${result.branch}.${hint}${previewNote}${sourceNote}${patchNote}`,
        };
      } catch (e: unknown) {
        const err = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          pushed: false,
          branch: '',
          error: err,
        };
      }
    },
  };
}

export function getSandboxTools(
  sandbox: Sandbox,
  requirementId?: string,
  toolsCtx?: SandboxToolsContext,
) {
  return [
    skillLookupTool({ requirement_type: toolsCtx?.requirement_type }),
    sandboxRunCommandTool(sandbox),
    sandboxWriteFileTool(sandbox),
    sandboxReadFileTool(sandbox),
    sandboxListFilesTool(sandbox),
    sandboxRestoreCheckpointTool(sandbox, requirementId, toolsCtx?.instance_id),
    sandboxPushCheckpointTool(sandbox, requirementId, toolsCtx),
  ];
}
