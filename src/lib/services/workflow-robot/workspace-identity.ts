function safeRunId(runPlanId: string): string {
  return String(runPlanId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 39);
}

export function workflowSandboxName(runPlanId: string): string {
  return `wf-${safeRunId(runPlanId)}`;
}

export function workflowBrowserSession(runPlanId: string): string {
  return `workflow-${safeRunId(runPlanId)}`;
}
