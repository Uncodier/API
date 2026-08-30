import { readFileSync } from 'fs';
import { join } from 'path';

const loaderPath = join(
  process.cwd(),
  'src/lib/workflow-runtime/strip-dispatcher-loader.cjs'
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const loader = require(loaderPath) as (this: { cacheable?: () => void }, source: string) => string;

function run(source: string): string {
  return loader.call({ cacheable() {} }, source);
}

describe('workflowStripDispatcherLoader', () => {
  it('loads as a webpack loader module', () => {
    expect(readFileSync(loaderPath, 'utf8')).toContain('workflowStripDispatcherLoader');
  });

  it('forces isNodeHttpEnabled to true', () => {
    const source = `export function isNodeHttpEnabled(env = process.env) {
    return envFlag(NODE_HTTP_ENV_VAR, NODE_HTTP_DEFAULT, env);
}`;
    expect(run(source)).toContain('return true;');
    expect(run(source)).not.toContain('envFlag');
  });

  it('drops the queue dispatcher', () => {
    const source =
      'export function getQueueDispatcher(config) {\n    return config?.dispatcher ?? getDefaultDispatcher();\n}';
    expect(run(source)).toContain('return undefined;');
  });

  it('strips dispatcher from instrumented fetch', () => {
    const source =
      'response = await fetch(url, {\n                    method,\n                    headers,\n                    body,\n                    signal,\n                    dispatcher,\n                });';
    expect(run(source)).toContain('await fetch(url, { method, headers, body, signal })');
    expect(run(source)).not.toContain('dispatcher');
  });
});
