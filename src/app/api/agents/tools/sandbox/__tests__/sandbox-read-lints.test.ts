// Offline dependency boundaries, matching sandbox-batch-read-tool.test.ts.
jest.mock('@vercel/sandbox', () => ({ Sandbox: {} }));
jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));
jest.mock('../assistantProtocol', () => ({
  deductSandboxToolCredits: jest.fn().mockResolvedValue({ success: true }),
  liveSandbox: (sandbox: unknown, ctx?: { activeSandboxRef?: { current: unknown } }) =>
    ctx?.activeSandboxRef?.current ?? sandbox,
}));
jest.mock('../sandbox-file-freshness', () => ({}));

import type { Sandbox } from '@vercel/sandbox';
import { parseCommandLine } from 'typescript';
import { deductSandboxToolCredits } from '../assistantProtocol';
import { sandboxReadLintsTool } from '../sandbox-fs-tools';

const ROOT = '/vercel/sandbox';
const credits = jest.mocked(deductSandboxToolCredits);

function commandResult(exitCode = 0, stdout = '', stderr = '') {
  return {
    exitCode,
    stdout: jest.fn().mockResolvedValue(stdout),
    stderr: jest.fn().mockResolvedValue(stderr),
  };
}

function createSandbox() {
  return {
    runCommand: jest.fn().mockResolvedValue(commandResult()),
    fs: {
      stat: jest.fn().mockResolvedValue({}),
      realpath: jest.fn(async (path: string) => path),
    },
  };
}

function createTool(sandbox: ReturnType<typeof createSandbox>) {
  return sandboxReadLintsTool(sandbox as unknown as Sandbox);
}

function expectCommands(sandbox: ReturnType<typeof createSandbox>, paths: string[] = []) {
  expect(sandbox.runCommand.mock.calls).toEqual([
    [{ cmd: `${ROOT}/node_modules/.bin/tsc`, args: ['--noEmit', ...paths], cwd: ROOT }],
    [{
      cmd: `${ROOT}/node_modules/.bin/eslint`,
      args: ['--format', 'stylish', '--', ...(paths.length ? paths : ['.'])],
      cwd: ROOT,
    }],
  ]);
}

describe('sandbox_read_lints command safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    credits.mockResolvedValue({ success: true });
  });

  it.each([{}, { paths: [] }])('checks the workspace without shell or package downloads: %j', async (args) => {
    const sandbox = createSandbox();
    await expect(createTool(sandbox).execute(args)).resolves.toEqual({
      success: true,
      diagnostics: '--- TypeScript Diagnostics ---\nNo TypeScript errors.\n\n--- ESLint Diagnostics ---\nNo ESLint errors.',
    });
    expectCommands(sandbox);
    expect(sandbox.fs.stat).not.toHaveBeenCalled();
    expect(sandbox.fs.realpath).not.toHaveBeenCalled();
  });

  it('keeps relative, absolute, spaced and Next.js route paths as individual arguments', async () => {
    const sandbox = createSandbox();
    await createTool(sandbox).execute({ paths: [
      './src//a.ts',
      `${ROOT}/src/my component.tsx`,
      'src/app/(account)/[id]/page.tsx',
    ] });
    const paths = [
      `${ROOT}/src/a.ts`,
      `${ROOT}/src/my component.tsx`,
      `${ROOT}/src/app/(account)/[id]/page.tsx`,
    ];
    expectCommands(sandbox, paths);
    expect(sandbox.fs.realpath.mock.calls).toEqual([[ROOT], ...paths.map(path => [path])]);
    expect(sandbox.fs.stat.mock.calls).toEqual(paths.map(path => [path]));
  });

  it('treats shell syntax as literal filename text, never as executable shell code', async () => {
    const sandbox = createSandbox();
    const paths = [
      'src/a.ts; echo injected',
      'src/$(echo injected).ts',
      'src/`echo injected`.ts',
      'src/a.ts && echo injected',
      'src/a.ts | echo injected',
      'src/a.ts > marker',
      'src/"quoted" file.ts',
      "src/someone's file.ts",
    ];
    await createTool(sandbox).execute({ paths });
    expectCommands(sandbox, paths.map(path => `${ROOT}/${path}`));
  });

  it('prevents tsc response-file and option parsing even for option-like filenames', async () => {
    const sandbox = createSandbox();
    await createTool(sandbox).execute({ paths: ['@options.txt', './--watch.ts', 'src/a.ts --watch'] });
    const paths = [`${ROOT}/@options.txt`, `${ROOT}/--watch.ts`, `${ROOT}/src/a.ts --watch`];
    expectCommands(sandbox, paths);
    const readResponseFile = jest.fn();
    const parsed = parseCommandLine(sandbox.runCommand.mock.calls[0][0].args, readResponseFile);
    expect(readResponseFile).not.toHaveBeenCalled();
    expect(parsed.errors).toEqual([]);
    expect(parsed.options).toEqual({ noEmit: true });
    expect(parsed.fileNames).toEqual(paths);
  });

  it.each([
    ['not an array', 'src/a.ts'],
    ['null array', null],
    ['non-string entry', [42]],
    ['null entry', [null]],
    ['sparse array', new Array(1)],
    ['empty path', ['']],
    ['blank path', ['   ']],
    ['NUL', ['src/a\0.ts']],
    ['newline', ['src/a.ts\necho injected']],
    ['carriage return', ['src/a\r.ts']],
    ['tab', ['src/a\t.ts']],
    ['DEL', ['src/a\x7f.ts']],
    ['backslash traversal', ['..\\outside.ts']],
    ['tsc option', ['--watch']],
    ['eslint option', ['--config=/tmp/evil.js']],
    ['leading whitespace option', [' --fix']],
    ['stdin option', ['-']],
    ['parent traversal', ['../outside.ts']],
    ['internal parent traversal', ['src/../a.ts']],
    ['absolute parent traversal', [`${ROOT}/../outside.ts`]],
    ['outside absolute path', ['/tmp/outside.ts']],
    ['workspace prefix confusion', [`${ROOT}-other/a.ts`]],
    ['mixed valid and invalid paths', ['src/a.ts', '--build']],
  ])('rejects %s before filesystem access or commands', async (_label, paths) => {
    const sandbox = createSandbox();
    await expect(createTool(sandbox).execute({ paths: paths as string[] })).rejects.toThrow('Failed to read lints:');
    expect(sandbox.runCommand).not.toHaveBeenCalled();
    expect(sandbox.fs.stat).not.toHaveBeenCalled();
    expect(sandbox.fs.realpath).not.toHaveBeenCalled();
  });

  it.each(['/tmp/outside.ts', `${ROOT}-other/a.ts`])('rejects symlink escapes to %s', async (target) => {
    const sandbox = createSandbox();
    sandbox.fs.realpath.mockImplementation(async path => path === ROOT ? ROOT : target);
    await expect(createTool(sandbox).execute({ paths: ['src/link.ts'] })).rejects.toThrow('inside the workspace');
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('allows symlinks resolving within the canonical workspace', async () => {
    const sandbox = createSandbox();
    sandbox.fs.realpath.mockImplementation(async path => path.replace(ROOT, '/mnt/workspace'));
    await createTool(sandbox).execute({ paths: ['src/link.ts'] });
    expectCommands(sandbox, [`${ROOT}/src/link.ts`]);
  });

  it('fails closed if canonicalization fails', async () => {
    const sandbox = createSandbox();
    sandbox.fs.realpath.mockRejectedValue(new Error('permission denied'));
    await expect(createTool(sandbox).execute({ paths: ['src/a.ts'] })).rejects.toThrow('Failed to read lints: permission denied');
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('rejects non-literal glob input rather than allowing ESLint to expand it', async () => {
    const sandbox = createSandbox();
    sandbox.fs.stat.mockRejectedValue(new Error('ENOENT'));
    await expect(createTool(sandbox).execute({ paths: ['src/*.ts'] })).rejects.toThrow('Failed to read lints: ENOENT');
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });

  it('preserves trimmed stdout precedence and stderr fallback on nonzero exits', async () => {
    const sandbox = createSandbox();
    const tsc = commandResult(2, '  TS2322: incompatible type\n', 'ignored stderr');
    const eslint = commandResult(1, ' \n', '  ESLint failed\n');
    sandbox.runCommand.mockResolvedValueOnce(tsc).mockResolvedValueOnce(eslint);
    await expect(createTool(sandbox).execute({})).resolves.toEqual({
      success: false,
      diagnostics: '--- TypeScript Diagnostics ---\nTS2322: incompatible type\n\n--- ESLint Diagnostics ---\nESLint failed',
    });
    expectCommands(sandbox);
    for (const result of [tsc, eslint]) {
      expect(result.stdout).toHaveBeenCalledTimes(1);
      expect(result.stderr).toHaveBeenCalledTimes(1);
    }
  });

  it.each([[0, 0, true], [1, 0, false], [0, 1, false], [2, 2, false]])(
    'requires both exit codes to be zero (%s, %s)', async (tscExit, eslintExit, success) => {
      const sandbox = createSandbox();
      sandbox.runCommand.mockResolvedValueOnce(commandResult(tscExit as number))
        .mockResolvedValueOnce(commandResult(eslintExit as number));
      await expect(createTool(sandbox).execute({})).resolves.toMatchObject({ success });
      expectCommands(sandbox);
    },
  );

  it('reports missing installed binaries without attempting installation', async () => {
    const sandbox = createSandbox();
    sandbox.runCommand.mockResolvedValue(commandResult(127, '', 'binary not found'));
    await expect(createTool(sandbox).execute({})).resolves.toEqual({
      success: false,
      diagnostics: '--- TypeScript Diagnostics ---\nbinary not found\n\n--- ESLint Diagnostics ---\nbinary not found',
    });
    expectCommands(sandbox);
  });

  it('wraps SDK command failures without a shell or npx fallback', async () => {
    const sandbox = createSandbox();
    sandbox.runCommand.mockRejectedValue(new Error('binary unavailable'));
    await expect(createTool(sandbox).execute({})).rejects.toThrow('Failed to read lints: binary unavailable');
    expect(sandbox.runCommand.mock.calls).toEqual([
      [{ cmd: `${ROOT}/node_modules/.bin/tsc`, args: ['--noEmit'], cwd: ROOT }],
    ]);
  });

  it('uses the active sandbox reference and retains the credit-check contract', async () => {
    const initial = createSandbox();
    const active = createSandbox();
    const ctx = { activeSandboxRef: { current: active as unknown as Sandbox } };
    const args = { paths: ['src/a.ts'] };
    await sandboxReadLintsTool(initial as unknown as Sandbox, ctx).execute(args);
    expect(credits).toHaveBeenCalledWith(ctx, 'sandbox_read_lints', args);
    expectCommands(active, [`${ROOT}/src/a.ts`]);
    expect(initial.runCommand).not.toHaveBeenCalled();
    expect(initial.fs.realpath).not.toHaveBeenCalled();
  });

  it('does not run when the credit check fails', async () => {
    const sandbox = createSandbox();
    credits.mockResolvedValue({ success: false, error: 'not permitted' });
    await expect(createTool(sandbox).execute({})).rejects.toThrow('not permitted');
    expect(sandbox.runCommand).not.toHaveBeenCalled();
    expect(sandbox.fs.realpath).not.toHaveBeenCalled();
  });
});