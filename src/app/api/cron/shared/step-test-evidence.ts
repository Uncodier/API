import type { Sandbox } from '@vercel/sandbox';
import { SandboxService } from '@/lib/services/sandbox-service';
import { sanitizeRuntimeLog } from './runtime-log-context';

const OUTPUT_TAIL_LIMIT = 6_000;
const DEFAULT_TEST_TIMEOUT_MS = 3 * 60_000;
const MAX_TEST_TIMEOUT_MS = 15 * 60_000;

export interface TestEvidenceSignal {
  command: string;
  exit_code: number;
  output_tail: string;
  ran_after_changes: boolean;
  captured_at: string;
}

export interface TestSignal {
  ok: boolean;
  tests: TestEvidenceSignal[];
}

function declaredTestTimeoutMs(configured?: number): number {
  const fromEnvironment = Number.parseInt(
    process.env.DECLARED_TEST_COMMAND_TIMEOUT_MS || '',
    10,
  );
  const explicit =
    Number.isFinite(configured) && Number(configured) > 0
      ? Number(configured)
      : undefined;
  const requested = explicit ?? (
    Number.isFinite(fromEnvironment) && fromEnvironment > 0
      ? fromEnvironment
      : DEFAULT_TEST_TIMEOUT_MS
  );
  return Math.min(Math.max(requested, 1), MAX_TEST_TIMEOUT_MS);
}

function outputTail(value: string): string {
  const sanitized = sanitizeRuntimeLog(value);
  return sanitized.length > OUTPUT_TAIL_LIMIT
    ? sanitized.slice(-OUTPUT_TAIL_LIMIT)
    : sanitized;
}

function parseToolResult(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : { output: value };
  } catch {
    return { output: value };
  }
}

function isTestCommand(command: string): boolean {
  return (
    /\b(?:jest|vitest|mocha|playwright\s+test)\b/i.test(command) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?\b/i.test(command)
  );
}

function resultOutput(result: Record<string, unknown>): string {
  return [
    result.stdout,
    result.stderr,
    result.recent_output,
    result.output,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

export function extractTestEvidenceFromResult(
  result: {
    steps?: Array<{
      toolCalls?: Array<{
        id?: string;
        toolCallId?: string;
        toolName?: string;
        args?: Record<string, unknown>;
      }>;
      toolResults?: Array<{
        toolCallId?: string;
        isError?: boolean;
        result?: unknown;
        content?: unknown;
      }>;
    }>;
  },
): TestEvidenceSignal[] {
  const tests: TestEvidenceSignal[] = [];
  const backgroundCommands = new Map<
    string,
    { command: string; mutationVersion: number }
  >();
  let mutationVersion = 0;

  for (const step of result.steps || []) {
    const results = new Map(
      (step.toolResults || []).map((toolResult) => [
        toolResult.toolCallId,
        toolResult,
      ]),
    );
    for (const toolCall of step.toolCalls || []) {
      const name = toolCall.toolName || '';
      const args = toolCall.args || {};
      const toolResult = results.get(toolCall.id || toolCall.toolCallId);
      const parsed = parseToolResult(
        toolResult?.result ?? toolResult?.content,
      );

      if (
        name === 'sandbox_write_file' ||
        name === 'sandbox_edit_file' ||
        name === 'sandbox_delete_file'
      ) {
        mutationVersion++;
        for (const test of tests) test.ran_after_changes = false;
        continue;
      }

      if (name === 'sandbox_start_background_command') {
        const command =
          typeof args.command === 'string' ? args.command.trim() : '';
        const logFile =
          typeof parsed.log_file === 'string'
            ? parsed.log_file
            : typeof args.log_file === 'string'
              ? args.log_file
              : '';
        if (command && logFile && isTestCommand(command)) {
          backgroundCommands.set(logFile, { command, mutationVersion });
        }
        continue;
      }

      let command = '';
      let ranAfterChanges = true;
      if (name === 'sandbox_run_command') {
        const executable =
          typeof args.command === 'string' ? args.command : '';
        const commandArgs = Array.isArray(args.args)
          ? args.args.filter((arg): arg is string => typeof arg === 'string')
          : [];
        command = [executable, ...commandArgs].filter(Boolean).join(' ');
      } else if (name === 'sandbox_check_background_command') {
        const logFile =
          typeof args.log_file === 'string' ? args.log_file : '';
        const started = backgroundCommands.get(logFile);
        if (
          parsed.is_running === true ||
          typeof parsed.exit_code !== 'number'
        ) {
          continue;
        }
        command = started?.command ||
          (typeof parsed.command === 'string' ? parsed.command : '');
        ranAfterChanges =
          !!started && started.mutationVersion === mutationVersion;
      }

      if (!command || !isTestCommand(command)) continue;
      const exitCode =
        typeof parsed.exitCode === 'number'
          ? parsed.exitCode
          : typeof parsed.exit_code === 'number'
            ? parsed.exit_code
            : toolResult?.isError
              ? 1
              : undefined;
      if (exitCode === undefined) continue;
      tests.push({
        command,
        exit_code: exitCode,
        output_tail: outputTail(resultOutput(parsed)),
        ran_after_changes: ranAfterChanges,
        captured_at: new Date().toISOString(),
      });
    }
  }
  return tests;
}

export async function runDeclaredTestCommand(
  sandbox: Sandbox,
  command: string,
  options: { timeoutMs?: number } = {},
): Promise<TestSignal> {
  const timeoutMs = declaredTestTimeoutMs(options.timeoutMs);
  const signal = AbortSignal.timeout(timeoutMs);
  const capturedAt = new Date().toISOString();
  try {
    const result = await sandbox.runCommand(
      'sh',
      [
        '-c',
        `cd "${SandboxService.WORK_DIR}" && ${command} 2>&1`,
      ],
      { signal },
    );
    const [stdout, stderr] = await Promise.all([
      result.stdout().catch(() => ''),
      result.stderr().catch(() => ''),
    ]);
    const exitCode = result.exitCode ?? -1;
    return {
      ok: exitCode === 0,
      tests: [{
        command,
        exit_code: exitCode,
        output_tail: outputTail(
          [stdout, stderr].filter(Boolean).join('\n'),
        ),
        // The deterministic gate runs after the producer turn and after the
        // step baseline was captured, so this receipt is current by construction.
        ran_after_changes: true,
        captured_at: capturedAt,
      }],
    };
  } catch (error: unknown) {
    if (!signal.aborted) throw error;
    return {
      ok: false,
      tests: [{
        command,
        exit_code: 124,
        output_tail:
          `Declared test command timed out after ${timeoutMs}ms before exiting.`,
        ran_after_changes: true,
        captured_at: capturedAt,
      }],
    };
  }
}
