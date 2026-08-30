/**
 * Runs once per Node server / serverless isolate, before request handling.
 * Forces Workflow off the broken undici-Agent-through-Next-fetch path.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'edge') return;

  process.env.WORKFLOW_NODE_HTTP = '1';

  const { installWorkflowSafeFetch } = await import('@/lib/workflow-runtime/safe-fetch');
  installWorkflowSafeFetch();
}
