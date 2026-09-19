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

  it('captures a background receipt completed in a later turn', () => {
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
        ran_after_changes: true,
      }),
    ]);
  });
});
