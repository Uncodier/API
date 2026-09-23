import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';

const DEFAULT_BACKGROUND_TEST_TIMEOUT_MS = 3 * 60_000;
const MAX_BACKGROUND_TEST_TIMEOUT_MS = 15 * 60_000;

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
  isTestCommand?: (command: string) => boolean;
  captureTestFingerprint?: (
    sandbox: Sandbox,
  ) => Promise<string | undefined>;
  persistCompletedTest?: (params: {
    sandbox: Sandbox;
    command: string;
    exitCode: number;
    output: string;
    workspaceFingerprint?: string;
    ranAfterChanges: boolean;
  }) => Promise<void>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function backgroundTestTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.BACKGROUND_TEST_COMMAND_TIMEOUT_MS || '',
    10,
  );
  return Math.min(
    Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_BACKGROUND_TEST_TIMEOUT_MS,
    MAX_BACKGROUND_TEST_TIMEOUT_MS,
  );
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
      const fingerprintFile = `${logFile}.fingerprint`;
      const cwd = dependencies.resolvePath(
        args.cwd,
        SandboxService.WORK_DIR,
      );
      const isTestCommand =
        dependencies.isTestCommand?.(args.command) === true;
      const timeoutMs = isTestCommand
        ? backgroundTestTimeoutMs()
        : undefined;
      const commandBody = isTestCommand
        ? `if command -v timeout >/dev/null 2>&1; then timeout ${Math.ceil(timeoutMs! / 1_000)}s sh -c ${shellQuote(args.command)}; else sh -c ${shellQuote(args.command)}; fi`
        : args.command;
      const wrappedCommand =
        `( ${commandBody} ) > ${shellQuote(logFile)} 2>&1; ` +
        `CODE=$?; printf '%s' "$CODE" > ${shellQuote(exitFile)}; exit "$CODE"`;
      const testFingerprint =
        isTestCommand
          ? await dependencies.captureTestFingerprint?.(activeSandbox)
              .catch(() => undefined)
          : undefined;
      await activeSandbox.writeFiles([
        { path: commandFile, content: args.command },
        ...(testFingerprint
          ? [{ path: fingerprintFile, content: testFingerprint }]
          : []),
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
          ...(timeoutMs ? { timeoutMs: timeoutMs + 10_000 } : {}),
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
            fingerprint_file: testFingerprint
              ? fingerprintFile
              : undefined,
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
        fingerprint_file: testFingerprint ? fingerprintFile : undefined,
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
      let startingFingerprint: string | undefined;
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
      try {
        const value = await activeSandbox.fs.readFile(
          `${args.log_file}.fingerprint`,
          'utf8',
        );
        startingFingerprint = String(value || '').trim() || undefined;
      } catch {
        // Non-test commands and legacy receipts do not have a fingerprint.
      }
      const persistCompletedTest = async (
        exitCode: number | null | undefined,
        output: string,
      ) => {
        if (
          typeof exitCode !== 'number' ||
          !originalCommand ||
          !dependencies.isTestCommand?.(originalCommand) ||
          !dependencies.persistCompletedTest
        ) {
          return;
        }
        try {
          const currentFingerprint =
            await dependencies.captureTestFingerprint?.(activeSandbox);
          await dependencies.persistCompletedTest({
            sandbox: activeSandbox,
            command: originalCommand,
            exitCode,
            output,
            workspaceFingerprint: currentFingerprint,
            ranAfterChanges:
              !!startingFingerprint &&
              startingFingerprint === currentFingerprint,
          });
        } catch (error: unknown) {
          console.warn(
            '[SandboxBackground] Could not persist test receipt:',
            error instanceof Error ? error.message : error,
          );
        }
      };
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
          if (!running) {
            await persistCompletedTest(
              command?.exitCode,
              logResult.stdout,
            );
          }
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
        await persistCompletedTest(exitCode, logResult.stdout);
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
