import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { delimiter, join } from 'node:path';
import { postgresBinDirectory } from './fixtures/workflow-postgres';

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'), execFileSync: jest.fn(),
}));
jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'), accessSync: jest.fn(),
}));

describe('local PostgreSQL binary resolution', () => {
  beforeEach(() => jest.resetAllMocks());

  it.each(['/usr/lib/postgresql/17/bin', '/opt/homebrew/opt/postgresql@17/bin'])(
    'uses the complete installation reported by pg_config: %s', (bin) => {
      const config = jest.mocked(childProcess.execFileSync).mockReturnValue(`${bin}\n`);
      const access = jest.mocked(fs.accessSync).mockImplementation(() => undefined);

      expect(postgresBinDirectory('/usr/bin')).toBe(bin);
      expect(config).toHaveBeenCalledWith('pg_config', ['--bindir'], expect.objectContaining({
        env: { NODE_ENV: 'test', PATH: '/usr/bin', LC_ALL: 'C' },
      }));
      for (const executable of ['initdb', 'pg_ctl', 'psql']) {
        expect(access).toHaveBeenCalledWith(join(bin, executable), fs.constants.X_OK);
      }
    },
  );

  it('falls back to a complete installation on PATH when pg_config is unavailable', () => {
    jest.mocked(childProcess.execFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    jest.mocked(fs.accessSync).mockImplementation((file) => {
      if (!String(file).startsWith('/test/postgres/bin/')) throw new Error('ENOENT');
    });

    expect(postgresBinDirectory(['/test/client/bin', '/test/postgres/bin'].join(delimiter)))
      .toBe('/test/postgres/bin');
  });

  it('rejects incomplete installations instead of mixing client and server binaries', () => {
    jest.mocked(childProcess.execFileSync).mockReturnValue('/test/server/bin\n');
    jest.mocked(fs.accessSync).mockImplementation((file) => {
      if (file === '/test/server/bin/psql' || file === '/test/client/bin/initdb') {
        throw new Error('ENOENT');
      }
    });

    expect(() => postgresBinDirectory('/test/client/bin')).toThrow('Local PostgreSQL binaries');
  });
});