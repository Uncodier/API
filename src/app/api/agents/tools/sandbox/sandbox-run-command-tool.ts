import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import {
  captureSandboxTestFingerprint,
  isSandboxTestCommand,
  persistSandboxTestReceipt,
} from './sandbox-test-receipt';

type RunCommandToolsContext = {
  activeSandboxRef?: { current: Sandbox };
  active_step_id?: string;
  backlog_item_id?: string;
};

interface RunCommandDependencies {
  liveSandbox: (
    sandbox: Sandbox,
    toolsCtx?: RunCommandToolsContext,
  ) => Sandbox;
  resolvePath: (inputPath: string | undefined, defaultPath: string) => string;
  deductCredits: (
    toolsCtx: RunCommandToolsContext | undefined,
    toolName: string,
    args: unknown,
  ) => Promise<{ success: boolean; error?: string }>;
}

export function createSandboxRunCommandTool(
  sandbox: Sandbox,
  toolsCtx: RunCommandToolsContext | undefined,
  requirementId: string | undefined,
  dependencies: RunCommandDependencies,
) {
  const workDir = SandboxService.WORK_DIR;
  return {
    name: 'sandbox_run_command',
    description:
      `Execute a shell command inside the Vercel Sandbox microVM. The default working directory is ${workDir} which contains the cloned repository. DO NOT USE for long-running commands like 'npm run build' or tests—use sandbox_start_background_command instead to avoid timeouts.`,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to run (e.g., "npm", "ls", "git")',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of arguments for the command',
        },
        cwd: {
          type: 'string',
          description: `Optional working directory. Defaults to ${workDir}`,
        },
      },
      required: ['command'],
    },
    execute: async (args: {
      command: string;
      args?: string[];
      cwd?: string;
    }) => {
      const creditCheck = await dependencies.deductCredits(
        toolsCtx,
        'sandbox_run_command',
        args,
      );
      if (!creditCheck.success) {
        return {
          stdout: '',
          stderr: `BLOCKED: ${creditCheck.error}`,
          exitCode: 1,
        };
      }

      const fullCommand = [args.command, ...(args.args || [])].join(' ');
      if (
        /create-next-app|create-react-app|create-vite|npm init|yarn init|pnpm init/i
          .test(fullCommand)
      ) {
        return {
          stdout: '',
          stderr:
            'BLOCKED: Scaffolding commands are forbidden. The project already exists at the repository root. Write files directly instead.',
          exitCode: 1,
        };
      }

      let command = args.command;
      let commandArgs = args.args || [];
      if (command.includes(' ')) {
        commandArgs = ['-c', fullCommand];
        command = 'sh';
      }

      const activeSandbox = dependencies.liveSandbox(sandbox, toolsCtx);
      const isTest = isSandboxTestCommand(fullCommand);
      const fingerprintBefore = isTest
        ? await captureSandboxTestFingerprint(activeSandbox)
            .catch(() => undefined)
        : undefined;
      const execution = await SandboxService.runCommandInSandbox(
        activeSandbox,
        command,
        commandArgs,
        dependencies.resolvePath(args.cwd, workDir),
      );

      if (isTest) {
        try {
          const fingerprintAfter =
            await captureSandboxTestFingerprint(activeSandbox);
          await persistSandboxTestReceipt({
            sandbox: activeSandbox,
            requirementId,
            backlogItemId: toolsCtx?.backlog_item_id,
            stepId: toolsCtx?.active_step_id,
            command: fullCommand,
            exitCode: execution.exitCode,
            output: [execution.stdout, execution.stderr]
              .filter(Boolean)
              .join('\n'),
            workspaceFingerprint: fingerprintAfter,
            ranAfterChanges:
              !!fingerprintBefore &&
              fingerprintBefore === fingerprintAfter,
          });
        } catch (error: unknown) {
          console.warn(
            '[SandboxRunCommand] Could not persist test receipt:',
            error instanceof Error ? error.message : error,
          );
        }
      }
      return execution;
    },
  };
}
