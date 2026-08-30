'use strict';

/**
 * Workflow SDK calls global fetch with an npm undici Agent as `dispatcher`.
 * Next.js fetch is a different undici copy (and a Proxy), so Agent.dispatch
 * throws on private field `#k`.
 *
 * Rewrite the SDK source before webpack packs it so those requests never pass
 * a dispatcher. Also force WORKFLOW_NODE_HTTP: Next may inline the env as
 * undefined inside node_modules.
 */
module.exports = function workflowStripDispatcherLoader(source) {
  if (this.cacheable) this.cacheable();
  if (typeof source !== 'string') return source;

  let next = source;

  next = next.replace(
    /export function isNodeHttpEnabled\([^)]*\)\s*\{\s*return envFlag\([^)]+\);\s*\}/,
    'export function isNodeHttpEnabled() { return true; }'
  );

  next = next.replace(
    'return config?.dispatcher ?? getDefaultDispatcher();',
    'return undefined;'
  );

  next = next.replace(
    /await fetch\(([^;\n]+), \{\s*method,\s*headers,\s*body,\s*signal,\s*dispatcher,?\s*\}\)/g,
    'await fetch($1, { method, headers, body, signal })'
  );

  next = next.replace(
    /await fetch\(url, \{\s*method:\s*'POST',\s*duplex:\s*'half',\s*dispatcher:\s*httpAgent,\s*headers,\s*body,?\s*\}\)/g,
    "await fetch(url, { method: 'POST', duplex: 'half', headers, body })"
  );

  next = next.replace(
    /await fetch\(new Request\(url, \{ \.\.\.options, body, headers, signal \}\), \{\s*dispatcher:\s*getDispatcher\(config\),?\s*\}\)/g,
    'await fetch(new Request(url, { ...options, body, headers, signal }))'
  );

  return next;
};
