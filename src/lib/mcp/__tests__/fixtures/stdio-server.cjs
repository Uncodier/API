// Deliberately outside Jest's *.test.ts match. No tsx, Next bootstrap, .env,
// provider imports, or database: only the catalog is replaced, never the SDK.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { z } = require('zod');

const root = path.resolve(__dirname, '../../../../..');

function evaluate(relativePath, dependencies, globals = {}) {
  const filename = path.join(root, relativePath);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(name) {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected fixture import: ${name}`);
      return dependencies[name];
    },
    // Use host Error so production instanceof Error retains normal semantics.
    Error, console, process: { env: {} }, ...globals,
  }, { filename });
  return module.exports;
}

function loadSharedServer(getAssistantTools) {
  const context = evaluate('src/lib/mcp/context.ts', { zod: { z } });
  const sanitizer = evaluate('src/app/api/cron/shared/runtime-log-context.ts', {});
  return evaluate('src/lib/mcp/server.ts', {
    '@/app/api/robots/instance/assistant/utils': { getAssistantTools },
    '@modelcontextprotocol/sdk/server/index.js': require('@modelcontextprotocol/sdk/server/index.js'),
    '@modelcontextprotocol/sdk/types.js': require('@modelcontextprotocol/sdk/types.js'),
    '@modelcontextprotocol/sdk/validation/ajv': require('@modelcontextprotocol/sdk/validation/ajv'),
    '@/app/api/cron/shared/runtime-log-context': sanitizer,
    zod: { z },
    'zod-to-json-schema': require('zod-to-json-schema'),
    '@/lib/mcp/remote-client': { shouldUseRemoteApi: () => false },
    '@/lib/mcp/context': context,
  });
}

async function main() {
  // The SDK merges a small default environment. Tests override those entries;
  // discard even the empty placeholders before evaluating application code.
  process.env = process.env.PATH ? { PATH: process.env.PATH } : {};
  const options = JSON.parse(process.argv[2]);
  let executions = 0;
  const { createMcpServer } = loadSharedServer((siteId, userId, instanceId, customTools) => {
    process.stderr.write('fixture:catalog-created\n');
    const context = { siteId, userId: userId ?? null, instanceId, customTools };
    return [
      { name: 'fixture_context', description: 'Echo normalized factory context',
        parameters: z.object({}), execute: async () => context },
      { name: 'fixture_echo', description: 'Typed deterministic echo',
        parameters: z.object({ message: z.string(), count: z.number().int().min(1).default(1) }).strict(),
        execute: async args => { executions++; return { ...args, executions }; } },
      { name: 'fixture_plain', description: 'Plain JSON schema validation',
        parameters: { type: 'object', properties: { value: { type: 'integer', minimum: 1 } }, required: ['value'], additionalProperties: false },
        execute: async args => { executions++; return { ...args, executions }; } },
      { name: 'fixture_throw', parameters: z.object({}),
        execute: async () => { throw new Error('Deterministic fixture failure'); } },
      { name: 'fixture_string', parameters: z.object({}), execute: async () => 'plain string result' },
    ];
  });
  const server = createMcpServer(options.siteId, options.userId, options.instanceId, options.customTools);
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // StdioServerTransport does not itself subscribe to EOF. Mirror the entrypoint
  // lifecycle explicitly and close without signals or forced successful exits.
  process.stdin.once('end', () => {
    server.close().then(() => process.stderr.write('fixture:eof-closed\n'), err => {
      process.stderr.write(`fixture:close-failed ${err.message}\n`);
      process.exitCode = 1;
    });
  });
}

module.exports = { evaluate, loadSharedServer };
if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`fixture:startup-failed ${err.message}\n`);
    process.exitCode = 1;
  });
}