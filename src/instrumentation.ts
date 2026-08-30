/**
 * Workflow's queue path ignores WORKFLOW_NODE_HTTP unless the SDK is rewritten
 * at compile time (see strip-dispatcher-loader.cjs). This hook only sets the
 * runtime flag for non-bundled reads.
 *
 * Do not wrap globalThis.fetch here. Next.js re-patches fetch; a getter/setter
 * wrapper recurses and takes down cron/API routes with
 * "Maximum call stack size exceeded".
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'edge') return;
  process.env.WORKFLOW_NODE_HTTP = '1';
}
