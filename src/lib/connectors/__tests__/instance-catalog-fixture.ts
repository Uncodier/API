import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { loadRuntimeModule } from '@/lib/custom-automation/test-helpers/load-runtime-module';

// Exercise the real assistant factory without importing unrelated native executors.
export function instanceCatalog(overrides: Record<string, unknown>) {
  const filename = 'src/app/api/robots/instance/assistant/assistant-tools.ts';
  const source = ts.createSourceFile(filename, readFileSync(path.resolve(filename), 'utf8'), ts.ScriptTarget.Latest, true);
  const dependencies: Record<string, any> = {};
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    const exports: Record<string, unknown> = {};
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const name = (element.propertyName ?? element.name).text;
      exports[name] = () => ({ name, description: name, parameters: { type: 'object', properties: {} }, execute: jest.fn() });
    }
    dependencies[(statement.moduleSpecifier as ts.StringLiteral).text] = exports;
  }
  return loadRuntimeModule<typeof import('@/app/api/robots/instance/assistant/assistant-tools')>(filename, {
    ...dependencies,
    '@/lib/procurement/tools': { createProcurementTools: () => [] },
    '@/lib/services/harness-diagnostics/tools': { createHarnessDiagnosticTools: () => [], refreshHarnessToolManifest: (tools: unknown) => tools },
    ...overrides,
  });
}
