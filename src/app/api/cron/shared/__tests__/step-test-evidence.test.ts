import {
  extractTestEvidenceFromResult,
  runDeclaredTestCommand,
} from '../step-test-evidence';

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));

describe('declared test evidence', () => {
  it('captures a current successful receipt', async () => {
    const sandbox = {
      runCommand: jest.fn().mockResolvedValue({
        exitCode: 0,
        stdout: jest.fn().mockResolvedValue('PASS assets.test.ts'),
        stderr: jest.fn().mockResolvedValue(''),
      }),
    };

    const result = await runDeclaredTestCommand(
      sandbox as any,
      'npm test -- assets.test.ts',
    );

    expect(result).toEqual({
      ok: true,
      tests: [expect.objectContaining({
        command: 'npm test -- assets.test.ts',
        exit_code: 0,
        output_tail: expect.stringContaining('PASS'),
        ran_after_changes: true,
      })],
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith(
      'sh',
      expect.any(Array),
      { signal: expect.any(AbortSignal) },
    );
  });

  it('returns a failed receipt when the declared command times out', async () => {
    const sandbox = {
      runCommand: jest.fn(
        (_command: string, _args: string[], options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true },
            );
          }),
      ),
    };

    await expect(runDeclaredTestCommand(
      sandbox as any,
      'npm test',
      { timeoutMs: 1 },
    )).resolves.toEqual({
      ok: false,
      tests: [expect.objectContaining({
        command: 'npm test',
        exit_code: 124,
        output_tail: expect.stringContaining('timed out'),
        ran_after_changes: true,
      })],
    });
  });

  it('captures direct and completed background test commands', () => {
    const tests = extractTestEvidenceFromResult({
      steps: [
        {
          toolCalls: [{
            id: 'direct',
            toolName: 'sandbox_run_command',
            args: { command: 'npm', args: ['test', '--', 'unit.test.ts'] },
          }],
          toolResults: [{
            toolCallId: 'direct',
            result: { exitCode: 0, stdout: 'PASS unit.test.ts' },
          }],
        },
        {
          toolCalls: [{
            id: 'start',
            toolName: 'sandbox_start_background_command',
            args: { command: 'npm test -- integration.test.ts' },
          }],
          toolResults: [{
            toolCallId: 'start',
            result: { success: true, log_file: '/tmp/test.log' },
          }],
        },
        {
          toolCalls: [{
            id: 'check',
            toolName: 'sandbox_check_background_command',
            args: { pid: '1', log_file: '/tmp/test.log' },
          }],
          toolResults: [{
            toolCallId: 'check',
            result: {
              is_running: false,
              exit_code: 0,
              recent_output: 'PASS integration.test.ts',
            },
          }],
        },
      ],
    });

    expect(tests).toEqual([
      expect.objectContaining({
        command: 'npm test -- unit.test.ts',
        exit_code: 0,
      }),
      expect.objectContaining({
        command: 'npm test -- integration.test.ts',
        exit_code: 0,
      }),
    ]);
  });

  it('invalidates a receipt when a later file mutation occurs', () => {
    const tests = extractTestEvidenceFromResult({
      steps: [{
        toolCalls: [
          {
            id: 'test',
            toolName: 'sandbox_run_command',
            args: { command: 'npm test' },
          },
          {
            id: 'edit',
            toolName: 'sandbox_edit_file',
            args: { path: 'src/app/page.tsx' },
          },
        ],
        toolResults: [{
          toolCallId: 'test',
          result: { exitCode: 0, stdout: 'PASS' },
        }],
      }],
    });

    expect(tests[0]?.ran_after_changes).toBe(false);
  });

  it('does not mark an untracked background receipt as current', () => {
    const tests = extractTestEvidenceFromResult({
      steps: [{
        toolCalls: [{
          id: 'check',
          toolName: 'sandbox_check_background_command',
          args: { pid: '1', log_file: '/tmp/test.log' },
        }],
        toolResults: [{
          toolCallId: 'check',
          result: {
            command: 'npx jest assets.test.ts',
            is_running: false,
            exit_code: 0,
            recent_output: 'PASS assets.test.ts',
          },
        }],
      }],
    });

    expect(tests).toEqual([
      expect.objectContaining({
        command: 'npx jest assets.test.ts',
        exit_code: 0,
        ran_after_changes: false,
      }),
    ]);
  });

  it('invalidates a tracked background test when a later turn mutates files', () => {
    const tests = extractTestEvidenceFromResult({
      steps: [
        {
          toolCalls: [{
            id: 'start',
            toolName: 'sandbox_start_background_command',
            args: { command: 'npm test', log_file: '/tmp/test.log' },
          }],
          toolResults: [{
            toolCallId: 'start',
            result: { success: true, log_file: '/tmp/test.log' },
          }],
        },
        {
          toolCalls: [{
            id: 'edit',
            toolName: 'sandbox_edit_file',
            args: { path: 'src/app/page.tsx' },
          }],
        },
        {
          toolCalls: [{
            id: 'check',
            toolName: 'sandbox_check_background_command',
            args: { log_file: '/tmp/test.log' },
          }],
          toolResults: [{
            toolCallId: 'check',
            result: { is_running: false, exit_code: 0, recent_output: 'PASS' },
          }],
        },
      ],
    });

    expect(tests[0]).toEqual(expect.objectContaining({
      ran_after_changes: false,
    }));
  });
});
