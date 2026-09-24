import { describe, expect, it, jest } from '@jest/globals';
import {
  ensureSearchBinaries,
  RG_BIN,
  SG_BIN,
} from '../code-search-binaries';

function result(stdout = '', exitCode = 0, stderr = '') {
  return {
    exitCode,
    stdout: jest.fn(async () => stdout),
    stderr: jest.fn(async () => stderr),
  };
}

describe('code search binary bootstrap', () => {
  it('links discovered binaries to the stable execution paths', async () => {
    const runCommand = jest.fn(async (input: {
      cmd: string;
      args?: string[];
    }) => {
      if (input.cmd === 'mkdir' || input.cmd === 'ln') return result();
      const script = input.args?.[1] || '';
      if (script.includes('command -v rg')) return result('/usr/bin/rg\n');
      if (script.includes('command -v sg')) return result('/usr/bin/sg\n');
      return result();
    });

    await expect(ensureSearchBinaries({ runCommand } as any)).resolves
      .toEqual(expect.objectContaining({ rg: true, sg: true }));
    expect(runCommand).toHaveBeenCalledWith({
      cmd: 'ln',
      args: ['-sf', '/usr/bin/rg', RG_BIN],
    });
    expect(runCommand).toHaveBeenCalledWith({
      cmd: 'ln',
      args: ['-sf', '/usr/bin/sg', SG_BIN],
    });
  });
});
