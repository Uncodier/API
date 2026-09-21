export function singleTurnGateInput() {
  return {
    sandbox: {} as any,
    effectiveSandboxId: 'sandbox-1',
    plan: { id: 'plan-1', title: 'Plan' },
    step: {
      id: 'step-1',
      order: 1,
      title: 'Step',
      instructions: 'Do it',
    },
    persistedStep: { id: 'step-1' },
    requirementId: 'req-1',
    instanceId: 'instance-1',
    siteId: 'site-1',
    requirementType: 'task',
    gitRepoKind: 'applications' as const,
    backlogItemId: 'item-1',
    interactionBaselineSha: 'abc123',
    systemPrompt: 'prompt',
    result: { messages: [] },
    fullTools: {},
    audit: {
      requirementId: 'req-1',
      instanceId: 'instance-1',
      siteId: 'site-1',
    },
    infrastructureGeneration: 3,
    executionEventId: 'cycle-1:step-1:turn-1',
  };
}
