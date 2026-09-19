import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';

type BackgroundToolsContext = {
  activeSandboxRef?: { current: Sandbox };
};

interface BackgroundToolDependencies {
  liveSandbox: (
    sandbox: Sandbox,
    toolsCtx?: BackgroundToolsContext,
  ) => Sandbox;
  resolvePath: (inputPath: string | undefined, defaultPath: string) => string;
  deductCredits: (
    toolsCtx: BackgroundToolsContext | undefined,
    toolName: string,
    args: unknown,
  ) => Promise<{ success: boolean; error?: string }>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createSandboxStartBackgroundCommandTool(
  sandbox: Sandbox,
  toolsCtx: BackgroundToolsContext | undefined,
  dependencies: BackgroundToolDependencies,
) {
  return {
    name: 'sandbox_start_background_command',
    description:
      'Start a long-running shell command in the background (like npm run build, npm test, etc) to avoid blocking the agent. Returns the PID and the log file path. You can check the status and output later using sandbox_check_background_command.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to run in the background',
        },
        cwd: {
          type: 'string',
          description: `Optional working directory. Defaults to ${SandboxService.WORK_DIR}`,
        },
      },
      required: ['command'],
    },
    execute: async (args: { command: string; cwd?: string }) => {
      const creditCheck = await dependencies.deductCredits(
        toolsCtx,
        'sandbox_start_background_command',
        args,
      );
      if (!creditCheck.success) return { error: creditCheck.error };

      const activeSandbox = dependencies.liveSandbox(sandbox, toolsCtx);
      const logFile = `/tmp/bg_cmd_${Date.now()}.log`;
      const exitFile = `${logFile}.exit`;
      const commandFile = `${logFile}.command`;
      const cwd = dependencies.resolvePath(
        args.cwd,
        SandboxService.WORK_DIR,
      );
      const wrappedCommand =
        `( ${args.command} ) > ${shellQuote(logFile)} 2>&1; ` +
        `CODE=$?; printf '%s' "$CODE" > ${shellQuote(exitFile)}; exit "$CODE"`;
      await activeSandbox.writeFiles([
        { path: commandFile, content: args.command },
      ]);

      try {
        const detached = await (
          activeSandbox as unknown as {
            runCommand: (
              options: Record<string, unknown>,
            ) => Promise<{ id?: string; cmdId?: string }>;
          }
        ).runCommand({
          cmd: 'sh',
          args: ['-c', wrappedCommand],
          cwd,
          detached: true,
        });
        const commandId = String(
          detached?.id || detached?.cmdId || '',
        ).trim();
        if (commandId) {
          return {
            success: true,
            pid: commandId,
            command_id: commandId,
            log_file: logFile,
            exit_file: exitFile,
            command_file: commandFile,
            message: `Command started detached (${commandId}). Use sandbox_check_background_command to check status and read logs.`,
          };
        }
      } catch {
        // SDK < 3 or detached commands unsupported.
      }

      const command = `nohup sh -c ${shellQuote(wrappedCommand)} >/dev/null 2>&1 & echo $!`;
      const result = await SandboxService.runCommandInSandbox(
        activeSandbox,
        'sh',
        ['-c', command],
        cwd,
      );
      const pid = result.stdout.trim();
      return {
        success: true,
        pid,
        log_file: logFile,
        exit_file: exitFile,
        command_file: commandFile,
        message: `Command started in background with PID ${pid}. Use sandbox_check_background_command to check status and read logs.`,
      };
    },
  };
}

export function createSandboxCheckBackgroundCommandTool(
  sandbox: Sandbox,
  toolsCtx: BackgroundToolsContext | undefined,
  dependencies: BackgroundToolDependencies,
) {
  return {
    name: 'sandbox_check_background_command',
    description:
      'Check the status of a background command and read the latest output from its log file.',
    parameters: {
      type: 'object',
      properties: {
        pid: {
          type: 'string',
          description: 'The PID returned by sandbox_start_background_command',
        },
        command_id: {
          type: 'string',
          description:
            'Optional detached command id from the SDK (same value as pid when started detached)',
        },
        log_file: {
          type: 'string',
          description:
            'The log file path returned by sandbox_start_background_command',
        },
      },
      required: ['pid', 'log_file'],
    },
    execute: async (args: {
      pid: string;
      log_file: string;
      command_id?: string;
    }) => {
      const activeSandbox = dependencies.liveSandbox(sandbox, toolsCtx);
      const commandId = String(args.command_id || args.pid || '').trim();
      let originalCommand = '';
      try {
        const value = await activeSandbox.fs.readFile(
          `${args.log_file}.command`,
          'utf8',
        );
        originalCommand = String(value || '').trim();
      } catch {
        // Commands started before command receipts were introduced have no
        // sidecar; callers can still inspect status and logs.
      }
      const getCommand = (
        activeSandbox as unknown as {
          getCommand?: (
            id: string,
          ) => Promise<{ exitCode?: number | null }>;
        }
      ).getCommand;
      if (typeof getCommand === 'function' && commandId) {
        try {
          const command = await getCommand.call(activeSandbox, commandId);
          const running = command?.exitCode == null;
          const logResult = await SandboxService.runCommandInSandbox(
            activeSandbox,
            'tail',
            ['-n', '200', args.log_file],
          );
          return {
            status: running ? 'RUNNING' : 'STOPPED',
            is_running: running,
            exit_code: command?.exitCode ?? null,
            command: originalCommand || undefined,
            recent_output: logResult.stdout,
            message: running
              ? `Detached command ${commandId} is still running. You can check again later.`
              : `Detached command ${commandId} has stopped. Check recent_output for errors or success.`,
          };
        } catch {
          // Fall through to the legacy PID check.
        }
      }

      const checkResult = await SandboxService.runCommandInSandbox(
        activeSandbox,
        'sh',
        [
          '-c',
          `kill -0 ${args.pid} 2>/dev/null && echo "RUNNING" || echo "STOPPED"`,
        ],
      );
      const status = checkResult.stdout.trim();
      const logResult = await SandboxService.runCommandInSandbox(
        activeSandbox,
        'tail',
        ['-n', '200', args.log_file],
      );
      let exitCode: number | null = null;
      if (status !== 'RUNNING') {
        const exitResult = await SandboxService.runCommandInSandbox(
          activeSandbox,
          'sh',
          ['-c', `cat ${shellQuote(`${args.log_file}.exit`)} 2>/dev/null || true`],
        );
        const parsed = Number.parseInt(exitResult.stdout.trim(), 10);
        if (Number.isInteger(parsed)) exitCode = parsed;
      }
      return {
        status,
        is_running: status === 'RUNNING',
        exit_code: exitCode,
        command: originalCommand || undefined,
        recent_output: logResult.stdout,
        message:
          status === 'RUNNING'
            ? `Process ${args.pid} is still running. You can check again later.`
            : `Process ${args.pid} has stopped. Check recent_output for errors or success.`,
      };
    },
  };
}
