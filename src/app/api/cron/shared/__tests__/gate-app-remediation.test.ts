const mockRunBuildAndOriginGate = jest.fn();

jest.mock('../step-git-gate', () => ({
  runBuildAndOriginGate: mockRunBuildAndOriginGate,
}));

import { runAppGate } from '../gates/gate-app';

const input = {
  flow: 'app' as const,
  sandbox: {} as never,
  workDir: '/vercel/sandbox',
  requirementId: 'requirement-1',
  appContext: {
    planTitle: 'Plan',
    stepOrder: 1,
    stepPrompt: 'Implement the page',
    currentMessages: [],
    assistantContext: {} as never,
    fullTools: [],
    lastResult: null,
  },
};

describe('app gate remediation handoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves attempt budget when mandatory remediation was scheduled', async () => {
    mockRunBuildAndOriginGate.mockResolvedValue({
      ok: false,
      error: 'Interaction remediation scheduled',
      signals: {
        interaction: {
          ok: false,
          findings: [],
          blocking_count: 0,
          deferred_count: 1,
          warning_count: 0,
          remediation_required: true,
          remediation_item_ids: ['repair-1'],
          active_item_suspended: true,
          summary: '0 blocking, 1 scheduled remediation, 0 warning',
        },
      },
    });

    const result = await runAppGate(input);

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      remediationScheduled: true,
      skipAttemptBump: true,
    }));
  });

  it('preserves the remediation handoff when other interaction findings block', async () => {
    mockRunBuildAndOriginGate.mockResolvedValue({
      ok: false,
      error: 'Interaction audit failed with remediation scheduled',
      signals: {
        interaction: {
          ok: false,
          findings: [],
          blocking_count: 1,
          deferred_count: 1,
          warning_count: 0,
          remediation_required: true,
          remediation_item_ids: ['repair-1'],
          active_item_suspended: true,
          summary: '1 blocking, 1 scheduled remediation, 0 warning',
        },
      },
    });

    const result = await runAppGate(input);

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      remediationScheduled: true,
      skipAttemptBump: true,
    }));
  });
});
