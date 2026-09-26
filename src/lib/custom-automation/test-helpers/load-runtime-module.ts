import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

/** Execute the real TS module with an explicit, fail-closed I/O boundary.
 * Works under both Jest ESM and CJS, without loading application/env setup.
 */
export function loadRuntimeModule<T>(relativePath: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(process.cwd(), relativePath);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      if (!Object.prototype.hasOwnProperty.call(dependencies, specifier)) {
        throw new Error(`Unmocked dependency in ${relativePath}: ${specifier}`);
      }
      return dependencies[specifier];
    },
    process: { env: {} },
    console,
    Buffer,
    crypto: { randomUUID: () => 'local-test-lock-token' },
    setTimeout,
    clearTimeout,
  }, { filename });
  return module.exports as T;
}