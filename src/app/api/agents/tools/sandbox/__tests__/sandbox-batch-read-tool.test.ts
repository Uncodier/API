jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));
jest.mock('../assistantProtocol', () => ({
  deductSandboxToolCredits: jest.fn().mockResolvedValue({ success: true }),
  liveSandbox: (sandbox: unknown) => sandbox,
  normalizeSandboxFsPath: (_root: string, path: string) => path,
  resolvePath: (path: string | undefined, root: string) =>
    path?.startsWith('/') ? path : `${root}/${path || ''}`,
}));
jest.mock('../sandbox-file-freshness', () => ({
  classifyFreshness: jest.fn(() => false),
  getGitPorcelainMap: jest.fn().mockResolvedValue({
    'src/a.ts': ' M',
  }),
}));

import { sandboxReadFilesTool } from '../sandbox-batch-read-tool';

describe('sandbox batch read tool', () => {
  it('reads related files in one ordered result', async () => {
    const sandbox = {
      fs: {
        readFile: jest.fn(async (path: string) => `content:${path}`),
        stat: jest.fn().mockResolvedValue({
          mtime: new Date('2026-09-22T12:00:00.000Z'),
        }),
      },
    };
    const tool = sandboxReadFilesTool(sandbox as any);

    await expect(tool.execute({
      paths: ['src/a.ts', 'src/b.ts'],
    })).resolves.toMatchObject({
      success: true,
      files: [
        {
          path: '/vercel/sandbox/src/a.ts',
          git_status: ' M',
        },
        {
          path: '/vercel/sandbox/src/b.ts',
          git_status: null,
        },
      ],
    });
    expect(sandbox.fs.readFile).toHaveBeenCalledTimes(2);
  });

  it('caps combined file content across the batch', async () => {
    const sandbox = {
      fs: {
        readFile: jest.fn().mockResolvedValue('x'.repeat(30_000)),
        stat: jest.fn().mockResolvedValue({
          mtime: new Date('2026-09-22T12:00:00.000Z'),
        }),
      },
    };
    const tool = sandboxReadFilesTool(sandbox as any);
    const result = await tool.execute({
      paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      max_chars_per_file: 30_000,
    });

    expect(result).toMatchObject({
      success: true,
      max_total_content_chars: 60_000,
      total_content_chars: 60_000,
    });
    const files = result.files;
    if (!files) {
      throw new Error('Expected batch file results');
    }
    expect(
      files.reduce(
        (total, file) => total + file.content.length,
        0,
      ),
    ).toBeLessThanOrEqual(60_000);
    expect(files[2]).toMatchObject({
      content: '',
      truncated: true,
    });
  });
});
