import { classifyFreshness, formatListLine, getGitPorcelainMap, StructuredListEntry } from '../sandbox-file-freshness';

const mockRunCommandInSandbox = jest.fn();

jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: {
    runCommandInSandbox: (...args: unknown[]) => mockRunCommandInSandbox(...args),
  }
}));

jest.mock('@vercel/sandbox', () => ({
  Sandbox: {}
}));

describe('sandbox-file-freshness', () => {
  describe('classifyFreshness', () => {
    it('returns null if no baseline or mtime', () => {
      expect(classifyFreshness(null, '2026-07-17T12:00:00Z')).toBeNull();
      expect(classifyFreshness('2026-07-17T12:00:00Z', undefined)).toBeNull();
    });

    it('returns true if mtime is after baseline', () => {
      expect(classifyFreshness('2026-07-17T12:05:00Z', '2026-07-17T12:00:00Z')).toBe(true);
    });

    it('returns true if mtime is exactly at baseline', () => {
      expect(classifyFreshness('2026-07-17T12:00:00Z', '2026-07-17T12:00:00Z')).toBe(true);
    });

    it('returns false if mtime is before baseline', () => {
      expect(classifyFreshness('2026-07-17T11:55:00Z', '2026-07-17T12:00:00Z')).toBe(false);
    });

    it('handles invalid dates gracefully', () => {
      expect(classifyFreshness('invalid', '2026-07-17T12:00:00Z')).toBeNull();
      expect(classifyFreshness('2026-07-17T12:00:00Z', 'invalid')).toBeNull();
    });
  });

  describe('formatListLine', () => {
    it('formats a regular file correctly', () => {
      const entry: StructuredListEntry = {
        name: 'page.tsx',
        type: 'file',
        size: 1234,
        mtime: '2026-07-17T12:00:00Z',
        updated_this_cycle: false,
        git_status: null
      };
      const formatted = formatListLine(entry);
      expect(formatted).toBe('-       1234 2026-07-17T12:00:00Z [unchanged_this_cycle] page.tsx');
    });

    it('formats a directory with updated_this_cycle true', () => {
      const entry: StructuredListEntry = {
        name: 'components',
        type: 'dir',
        size: 4096,
        mtime: '2026-07-17T12:05:00Z',
        updated_this_cycle: true,
        git_status: 'M '
      };
      const formatted = formatListLine(entry);
      expect(formatted).toBe('d       4096 2026-07-17T12:05:00Z [updated_this_cycle] [dirty:M ] components');
    });

    it('formats a symlink with unknown time', () => {
      const entry: StructuredListEntry = {
        name: 'link',
        type: 'symlink',
        size: 10,
        mtime: null,
        updated_this_cycle: null,
        git_status: '??'
      };
      const formatted = formatListLine(entry);
      expect(formatted).toBe('l         10 unknown_time [dirty:??] link');
    });
  });

  describe('getGitPorcelainMap', () => {
    const fakeSandbox = {} as any;

    beforeEach(() => {
      mockRunCommandInSandbox.mockReset();
    });

    it('parses modified, staged, and untracked entries', async () => {
      mockRunCommandInSandbox.mockResolvedValue({
        exitCode: 0,
        stdout: [
          ' M src/app/page.tsx',
          'A  src/lib/new-service.ts',
          '?? notes.txt',
          '',
        ].join('\n'),
      });

      const map = await getGitPorcelainMap(fakeSandbox, '/vercel/sandbox');
      expect(map).toEqual({
        'src/app/page.tsx': ' M',
        'src/lib/new-service.ts': 'A ',
        'notes.txt': '??',
      });
      expect(mockRunCommandInSandbox).toHaveBeenCalledWith(
        fakeSandbox, 'git', ['status', '--porcelain'], '/vercel/sandbox'
      );
    });

    it('uses the new path for renames', async () => {
      mockRunCommandInSandbox.mockResolvedValue({
        exitCode: 0,
        stdout: 'R  src/old-name.ts -> src/new-name.ts\n',
      });

      const map = await getGitPorcelainMap(fakeSandbox, '/vercel/sandbox');
      expect(map).toEqual({ 'src/new-name.ts': 'R ' });
    });

    it('strips quotes around paths with special characters', async () => {
      mockRunCommandInSandbox.mockResolvedValue({
        exitCode: 0,
        stdout: '?? "file with spaces.txt"\n',
      });

      const map = await getGitPorcelainMap(fakeSandbox, '/vercel/sandbox');
      expect(map).toEqual({ 'file with spaces.txt': '??' });
    });

    it('returns an empty map on clean tree', async () => {
      mockRunCommandInSandbox.mockResolvedValue({ exitCode: 0, stdout: '' });
      const map = await getGitPorcelainMap(fakeSandbox, '/vercel/sandbox');
      expect(map).toEqual({});
    });

    it('returns an empty map when git fails', async () => {
      mockRunCommandInSandbox.mockResolvedValue({ exitCode: 128, stdout: '' });
      const map = await getGitPorcelainMap(fakeSandbox, '/vercel/sandbox');
      expect(map).toEqual({});
    });

    it('returns an empty map when the command throws', async () => {
      mockRunCommandInSandbox.mockRejectedValue(new Error('sandbox gone'));
      const map = await getGitPorcelainMap(fakeSandbox, '/vercel/sandbox');
      expect(map).toEqual({});
    });
  });
});
