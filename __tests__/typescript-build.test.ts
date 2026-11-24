import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = process.cwd();

describe('TypeScript build validation', () => {
  it('keeps production type checking enabled without loading Next config or environment files', () => {
    const config = readFileSync(resolve(root, 'next.config.mjs'), 'utf8');
    expect(config).toMatch(/ignoreBuildErrors:\s*false/);
    expect(config).not.toMatch(/ignoreBuildErrors:\s*true/);
  });

  it('isolates Webpack compilation and enables memory optimizations before type checking', () => {
    const config = readFileSync(resolve(root, 'next.config.mjs'), 'utf8');
    expect(config).toMatch(/webpackBuildWorker:\s*true/);
    expect(config).toMatch(/webpackMemoryOptimizations:\s*true/);
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toBe('next build --webpack');
  });

  it('provides a standalone check with fresh Next.js route types', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.typecheck).toBe('next typegen && tsc --noEmit -p tsconfig.typecheck.json');
  });

  it('preserves strict checks and includes application and test TypeScript files', () => {
    const config = JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf8'));
    expect(config.compilerOptions.strict).toBe(true);
    expect(config.include).toEqual(expect.arrayContaining(['**/*.ts', '**/*.tsx']));
    expect(config.exclude).toEqual(['node_modules', 'src/lib/agentbase/test/**/*']);
  });

  it('checks current generated routes, source and tests even when obsolete dev types are present', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'api-typecheck-'));
    const source = 'src/app/api/current/route.ts';
    const test = 'src/app/api/current/__tests__/route.test.ts';
    const generated = '.next/types/validator.ts';
    const retired = '.next/dev/types/validator.ts';
    const configs = ['tsconfig.json', 'tsconfig.typecheck.json'];
    try {
      for (const name of configs) {
        writeFileSync(resolve(fixture, name), readFileSync(resolve(root, name)));
      }
      for (const file of ['next-env.d.ts', source, test, generated, retired, 'src/lib/agentbase/test/excluded.ts']) {
        const path = resolve(fixture, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'export {};\n');
      }
      const parsed = configs.map(name => ts.getParsedCommandLineOfConfigFile(resolve(fixture, name), {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: error => { throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n')); },
      }));
      const [editor, standalone] = parsed.map(config => {
        expect(config?.errors).toEqual([]);
        expect(config?.options.strict).toBe(true);
        return config?.fileNames.map(file => relative(fixture, file));
      });
      expect(editor).toContain(retired);
      expect(standalone?.sort()).toEqual(['next-env.d.ts', source, test, generated].sort());
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});