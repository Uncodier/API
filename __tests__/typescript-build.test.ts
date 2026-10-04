import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

describe('TypeScript build validation', () => {
  it('keeps production type checking enabled without loading Next config or environment files', () => {
    const config = readFileSync(resolve(root, 'next.config.mjs'), 'utf8');
    expect(config).toMatch(/ignoreBuildErrors:\s*false/);
    expect(config).not.toMatch(/ignoreBuildErrors:\s*true/);
  });

  it('provides a standalone check with fresh Next.js route types', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.typecheck).toBe('next typegen && tsc --noEmit');
  });

  it('preserves strict checks and includes application and test TypeScript files', () => {
    const config = JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf8'));
    expect(config.compilerOptions.strict).toBe(true);
    expect(config.include).toEqual(expect.arrayContaining(['**/*.ts', '**/*.tsx']));
    expect(config.exclude).toEqual(['node_modules', 'src/lib/agentbase/test/**/*']);
  });
});