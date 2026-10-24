import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import * as ts from 'typescript';

// Source-only contracts: do not import application code, load credentials, or
// invoke a workflow, database, sandbox or model provider.
const root = process.cwd();
const assistant = 'src/app/api/robots/instance/assistant';
const cron = 'src/app/api/cron/requirements-apps';
const harness = 'src/lib/harness';
const retired = [
  'engine', 'runtime', 'requirement-runtime', 'model', 'requirement-model', 'prompt',
].map(name => `${harness}/${name}`);

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, child => visit(child, inspect));
}

function localModule(from: string, specifier: string): string | undefined {
  const target = specifier.startsWith('@/')
    ? resolve(root, 'src', specifier.slice(2))
    : specifier.startsWith('.') ? resolve(root, dirname(from), specifier) : undefined;
  return target && relative(root, target).replace(/\\/g, '/').replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

function moduleReferences(file: ts.SourceFile): string[] {
  const references: string[] = [];
  visit(file, node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      references.push(node.arguments[0].text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)) references.push(node.argument.literal.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      references.push(node.moduleReference.expression.text);
    }
  });
  return references;
}

function productionFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    // Retired behavioral fixtures are intentionally retained only under tests.
    if (['__tests__', '__fixtures__', 'fixtures', 'node_modules'].includes(entry.name)) return [];
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return productionFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(?:test|spec)\.[jt]sx?$/.test(entry.name)
      ? [path] : [];
  });
}

function expectImportedCall(path: string, target: string, exportedName: string): void {
  const file = source(path);
  const locals: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        localModule(path, statement.moduleSpecifier.text) !== target || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly && (binding.propertyName ?? binding.name).text === exportedName) {
          locals.push(binding.name.text);
        }
      }
    }
  }
  const calls: string[] = [];
  visit(file, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text);
  });
  expect({ path, target, exportedName, importedAndCalled: locals.some(name => calls.includes(name)) })
    .toEqual({ path, target, exportedName, importedAndCalled: true });
}

describe('requirement execution has one canonical assistant path', () => {
  it('connects the production cron to canonical runtime, workspace and session', () => {
    expectImportedCall(`${cron}/workflow.ts`, `${cron}/agent-step`, 'executeRequirementCycle');
    expectImportedCall(`${cron}/agent-step.ts`, `${assistant}/requirement-runtime`, 'runRequirementCycle');
    expectImportedCall(`${assistant}/requirement-runtime.ts`, `${assistant}/requirement-workspace`,
      'executeRequirementAssistantWorkspace');
    expectImportedCall(`${assistant}/requirement-workspace.ts`, `${assistant}/requirement-session`,
      'runRequirementAssistantSlice');
  });

  it('uses the same context/prompt preparation and turn implementations as interactive execution', () => {
    expectImportedCall(`${assistant}/workflow.ts`, `${assistant}/steps`, 'prepareAssistantContext');
    expectImportedCall(`${assistant}/workflow.ts`, `${assistant}/assistant-turn`, 'processAssistantTurn');
    for (const [wrapper, implementation, name] of [
      ['steps', 'assistant-context', 'prepareAssistantContext'],
      ['assistant-turn', 'assistant-turn-core', 'processAssistantTurn'],
    ]) {
      expectImportedCall(`${assistant}/${wrapper}.ts`, `${assistant}/${implementation}`, name);
      expectImportedCall(`${assistant}/requirement-session.ts`, `${assistant}/${implementation}`, name);
      const exportedFunctions = source(`${assistant}/${wrapper}.ts`).statements
        .filter(ts.isFunctionDeclaration)
        .filter(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
        .map(node => node.name?.text);
      expect(exportedFunctions).toContain(name);
    }
  });

  it('has no production retired engine, runtime, model or prompt files', () => {
    expect(retired.filter(path => existsSync(resolve(root, `${path}.ts`)))).toEqual([]);
    // Storage and host tools are intentionally not retired with the model loop.
    for (const name of ['store', 'requirement-tools']) {
      expect(existsSync(resolve(root, harness, `${name}.ts`))).toBe(true);
    }
  });

  it('cannot import the retired executor or test archives from production host/assistant code', () => {
    const forbiddenImports: { path: string; specifier: string }[] = [];
    for (const path of [harness, assistant, cron].flatMap(productionFiles)) {
      for (const specifier of moduleReferences(source(path))) {
        const target = localModule(path, specifier);
        if (target && (retired.includes(target) ||
            /(?:^|\/)(?:__tests__|__fixtures__|fixtures)(?:\/|$)/.test(target) ||
            /\.(?:test|spec)$/.test(target))) forbiddenImports.push({ path, specifier });
      }
    }
    expect(forbiddenImports).toEqual([]);
  });
});