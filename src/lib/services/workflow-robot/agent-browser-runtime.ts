import type { Sandbox } from '@vercel/sandbox';

export interface AgentBrowserCommandResult {
  exitCode: number;
  json: unknown;
  stderr: string;
  stdout: string;
}

async function loadAgentBrowserRuntime() {
  return import('@agent-browser/sandbox/vercel');
}

export async function installWorkflowAgentBrowser(sandbox: Sandbox): Promise<void> {
  const runtime = await loadAgentBrowserRuntime();
  await runtime.installAgentBrowserInVercelSandbox(sandbox as any);
}

export async function runWorkflowAgentBrowserCommand(
  sandbox: Sandbox,
  args: string[],
  options: { json?: boolean; session?: string } = {},
): Promise<AgentBrowserCommandResult> {
  const runtime = await loadAgentBrowserRuntime();
  return runtime.runAgentBrowserCommand(
    sandbox as any,
    args,
    options,
  ) as Promise<AgentBrowserCommandResult>;
}
