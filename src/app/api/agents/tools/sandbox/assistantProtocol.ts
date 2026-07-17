import { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { supabaseAdmin } from '@/lib/database/supabase-client';
import { CreditService } from '@/lib/services/billing/CreditService';
import { persistActiveSandboxId } from '@/lib/tools/requirement-status-core';
import { updateInstancePlanCore } from '@/app/api/agents/tools/instance_plan/update/route';
import {
  commitWorkspaceToOrigin,
  syncLatestRequirementStatusWithPreview,
  patchLatestRequirementStatusColumns,
  resolveGitBindingForRequirement,
  type GitRepoKind,
} from '@/app/api/cron/shared/cron-commit-helpers';
import { gitBindingBranchTreeUrl } from '@/lib/services/requirement-git-binding';
import { sandboxRestoreCheckpointTool } from '@/app/api/agents/tools/sandbox/sandbox-checkpoint-restore';
import { skillLookupTool } from '@/app/api/agents/tools/sandbox/skill-lookup-tool';
import { sandboxCodeSearchTool } from '@/app/api/agents/tools/sandbox/code-search-tool';
import { sandboxReadLogsTool } from '@/app/api/agents/tools/sandbox_read_logs/assistantProtocol';
import { getQaSandboxTools } from '@/app/api/agents/tools/sandbox/qa-tools';
import { sandboxDbMigrateTool } from '@/app/api/agents/tools/sandbox/sandbox-db-migrate';
import { sandboxDbInspectTool } from '@/app/api/agents/tools/sandbox/sandbox-db-inspect';
import {
  sandboxWriteFileTool,
  sandboxReadLargeFileTool,
  sandboxReadFileTool,
  sandboxEditFileTool,
  sandboxDeleteFileTool,
  sandboxReadLintsTool,
  sandboxListFilesTool,
} from './sandbox-fs-tools';

const WORK_DIR = SandboxService.WORK_DIR;

export function liveSandbox(sandbox: Sandbox, toolsCtx?: SandboxToolsContext): Sandbox {
  return toolsCtx?.activeSandboxRef?.current ?? sandbox;
}

export function resolvePath(inputPath: string | undefined, defaultPath: string): string {
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
  /** ISO timestamp for classifying if files were updated this cycle (step.started_at or plan.started_at) */
  cycle_baseline_at?: string;
  /** Updated when sandbox_push_checkpoint snapshots the VM (SDK stops the old sandbox). */
  activeSandboxRef?: { current: Sandbox };
};

export async function deductSandboxToolCredits(
  toolsCtx: SandboxToolsContext | undefined,
  toolName: string,
  args: any
): Promise<{ success: boolean; error?: string }> {
  // We no longer deduct credits per tool call.
  // Sandbox usage is billed by the hour via a separate cron job or session tracker,
  // and tokens are billed via the assistant execution wrapper.
  return { success: true };
}

export function sandboxRunCommandTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_run_command',
    description: `Execute a shell command inside the Vercel Sandbox microVM. The default working directory is ${WORK_DIR} which contains the cloned repository. DO NOT USE for long-running commands like 'npm run build' or tests—use sandbox_start_background_command instead to avoid timeouts.`,
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
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_run_command', args);
      if (!creditCheck.success) {
        return {
          stdout: '',
          stderr: `BLOCKED: ${creditCheck.error}`,
          exitCode: 1,
        };
      }

      const fullCmd = [args.command, ...(args.args || [])].join(' ');
      const blocked = /create-next-app|create-react-app|create-vite|npm init|yarn init|pnpm init/i;
      if (blocked.test(fullCmd)) {
        return {
          stdout: '',
          stderr: 'BLOCKED: Scaffolding commands are forbidden. The project already exists at the repository root. Write files directly instead.',
          exitCode: 1,
        };
      }

      let cmdToRun = args.command;
      let cmdArgs = args.args || [];

      // Vercel Sandbox expects the cmd argument to be a single executable name.
      // If the model passes a full string like "npm run build" into the command field,
      // the Vercel API will throw a 400 "Status code 400 is not ok" error.
      if (cmdToRun.includes(' ')) {
        if (cmdArgs.length === 0) {
          cmdArgs = ['-c', cmdToRun];
          cmdToRun = 'sh';
        } else {
          cmdArgs = ['-c', fullCmd];
          cmdToRun = 'sh';
        }
      }

      const s0 = liveSandbox(sandbox, toolsCtx);
      return SandboxService.runCommandInSandbox(s0, cmdToRun, cmdArgs, resolvePath(args.cwd, WORK_DIR));
    }
  };
}

export function sandboxStartBackgroundCommandTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_start_background_command',
    description: 'Start a long-running shell command in the background (like npm run build, npm test, etc) to avoid blocking the agent. Returns the PID and the log file path. You can check the status and output later using sandbox_check_background_command.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run in the background' },
        cwd: { type: 'string', description: `Optional working directory. Defaults to ${WORK_DIR}` }
      },
      required: ['command']
    },
    execute: async (args: { command: string, cwd?: string }) => {
       const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_start_background_command', args);
       if (!creditCheck.success) {
         return { error: creditCheck.error };
       }
       
       const s0 = liveSandbox(sandbox, toolsCtx);
       const logFile = `/tmp/bg_cmd_${Date.now()}.log`;
       
       // Run the command in the background via sh
       const cmdStr = `nohup ${args.command} > ${logFile} 2>&1 & echo $!`;
       const result = await SandboxService.runCommandInSandbox(s0, 'sh', ['-c', cmdStr], resolvePath(args.cwd, WORK_DIR));
       
       const pid = result.stdout.trim();
       return {
         success: true,
         pid: pid,
         log_file: logFile,
         message: `Command started in background with PID ${pid}. Use sandbox_check_background_command to check status and read logs.`
       };
    }
  };
}

export function sandboxCheckBackgroundCommandTool(sandbox: Sandbox, toolsCtx?: SandboxToolsContext) {
  return {
    name: 'sandbox_check_background_command',
    description: 'Check the status of a background command and read the latest output from its log file.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'string', description: 'The PID returned by sandbox_start_background_command' },
        log_file: { type: 'string', description: 'The log file path returned by sandbox_start_background_command' }
      },
      required: ['pid', 'log_file']
    },
    execute: async (args: { pid: string, log_file: string }) => {
      const s0 = liveSandbox(sandbox, toolsCtx);
      
      // Check if process is running
      const checkResult = await SandboxService.runCommandInSandbox(s0, 'sh', ['-c', `kill -0 ${args.pid} 2>/dev/null && echo "RUNNING" || echo "STOPPED"`]);
      const status = checkResult.stdout.trim();
      
      // Read the last 200 lines of the log
      const logResult = await SandboxService.runCommandInSandbox(s0, 'tail', ['-n', '200', args.log_file]);
      
      return {
        status: status,
        is_running: status === 'RUNNING',
        recent_output: logResult.stdout,
        message: status === 'RUNNING' 
          ? `Process ${args.pid} is still running. You can check again later.`
          : `Process ${args.pid} has stopped. Check recent_output for errors or success.`
      };
    }
  };
}

// Filesystem tools live in ./sandbox-fs-tools (kept re-exported for existing importers).
export {
  sandboxWriteFileTool,
  sandboxReadLargeFileTool,
  sandboxReadFileTool,
  sandboxEditFileTool,
  sandboxDeleteFileTool,
  sandboxReadLintsTool,
  sandboxListFilesTool,
};

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
      const creditCheck = await deductSandboxToolCredits(toolsCtx, 'sandbox_push_checkpoint', args);
      if (!creditCheck.success) {
        return {
          ok: false,
          pushed: false,
          branch: '',
          error: creditCheck.error,
        };
      }

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
        const s0 = liveSandbox(sandbox, toolsCtx);
        const result = await commitWorkspaceToOrigin(
          s0,
          title,
          requirementId,
          `[checkpoint] ${label}`,
          checkpointAudit,
          {
            gitRepoKind: toolsCtx?.git_repo_kind,
            deferRequirementStatusPersist: true,
          },
        );
        if (result.sandboxReplacement && toolsCtx?.activeSandboxRef) {
          toolsCtx.activeSandboxRef.current = result.sandboxReplacement;
        }
        
        // Update active_sandbox_id in DB if we got a replacement sandbox
        if (result.sandboxReplacement && toolsCtx?.instance_id && requirementId) {
          try {
            await persistActiveSandboxId(requirementId, toolsCtx.instance_id, result.sandboxReplacement.sandboxId, toolsCtx.site_id);
          } catch (e) {
            console.error(`[sandbox_push_checkpoint] Failed to update active_sandbox_id to ${result.sandboxReplacement!.sandboxId}:`, e);
          }
        }

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

        const rk = toolsCtx?.git_repo_kind ?? 'applications';
        const binding = await resolveGitBindingForRequirement(requirementId, rk);
        const fallbackRepoUrl =
          result.branch != null && String(result.branch).trim() !== ''
            ? gitBindingBranchTreeUrl(binding, String(result.branch))
            : undefined;

        const cols: Partial<Record<'repo_url' | 'preview_url' | 'source_code' | 'snapshot_id', string>> = {};
        if (sync?.repo_url || fallbackRepoUrl) {
          cols.repo_url = (sync?.repo_url || fallbackRepoUrl) as string;
        }
        if (sync?.preview_url) cols.preview_url = sync.preview_url;
        if (result.source_code) cols.source_code = result.source_code;
        if (result.snapshotId?.trim()) cols.snapshot_id = result.snapshotId.trim();

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
          result.source_code
            ? ` source_code archive → requirement_status: ${result.source_code}`
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
          message: result.pushed
            ? `Pushed to origin on branch "${result.branch}".${previewNote}${sourceNote}${patchNote}`
            : `No push performed (clean tree in sync, or could not publish). branch=${result.branch}.${hint}${previewNote}${sourceNote}${patchNote}`,
        };
      } catch (e: any) {
        // If the error has a sandboxReplacement (because we took a snapshot despite the push error),
        // we MUST update the active sandbox ref, otherwise the agent will try to use a stopped VM.
        if (e.sandboxReplacement && toolsCtx?.activeSandboxRef) {
          toolsCtx.activeSandboxRef.current = e.sandboxReplacement;
        }
        if (e.sandboxReplacement && toolsCtx?.instance_id && requirementId) {
          persistActiveSandboxId(requirementId, toolsCtx.instance_id, e.sandboxReplacement.sandboxId, toolsCtx.site_id)
            .catch(err => console.error(`[sandbox_push_checkpoint] Failed to update active_sandbox_id to ${e.sandboxReplacement!.sandboxId}:`, err));
        }

        const errMessage = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          pushed: false,
          branch: e.branch || '',
          error: errMessage,
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
    skillLookupTool({ requirement_type: toolsCtx?.requirement_type, toolsCtx }),
    sandboxCodeSearchTool(sandbox, toolsCtx),
    sandboxRunCommandTool(sandbox, toolsCtx),
    sandboxStartBackgroundCommandTool(sandbox, toolsCtx),
    sandboxCheckBackgroundCommandTool(sandbox, toolsCtx),
    sandboxWriteFileTool(sandbox, toolsCtx),
    sandboxEditFileTool(sandbox, toolsCtx),
    sandboxDeleteFileTool(sandbox, toolsCtx),
    sandboxReadFileTool(sandbox, toolsCtx),
    sandboxReadLargeFileTool(sandbox, toolsCtx),
    sandboxListFilesTool(sandbox, toolsCtx),
    sandboxReadLintsTool(sandbox, toolsCtx),
    sandboxDbMigrateTool(sandbox, requirementId, toolsCtx),
    sandboxDbInspectTool(requirementId, toolsCtx),
    sandboxRestoreCheckpointTool(sandbox, requirementId, toolsCtx),
    sandboxPushCheckpointTool(sandbox, requirementId, toolsCtx),
    sandboxReadLogsTool(sandbox, toolsCtx),
    ...getQaSandboxTools(sandbox, requirementId, toolsCtx),
  ];
}
