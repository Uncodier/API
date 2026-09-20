import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunBuildAndOriginGate = jest.fn<
  (...args: any[]) => Promise<any>
>();

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

  it('preserves advisory disposition for automatic console findings', async () => {
    mockRunBuildAndOriginGate.mockResolvedValue({
      ok: true,
      signals: {
        console: {
          ok: false,
          entries: [],
          page_errors: [],
          failed_requests: [{ url: '/api/assets' }],
        },
        observations: [{
          kind: 'console',
          disposition: 'advisory',
          source: 'diff',
          detail: 'Automatic browser finding.',
        }],
      },
    });

    const result = await runAppGate(input);

    expect(result.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'console',
        ok: true,
        disposition: 'advisory',
      }),
    ]));
  });

  it('types confirmed gate failures as product defects', async () => {
    mockRunBuildAndOriginGate.mockResolvedValue({
      ok: false,
      error: 'Build failed',
      signals: {
        build: { ok: false, error_tail: 'Type error' },
      },
    });

    await expect(runAppGate(input)).resolves.toEqual(
      expect.objectContaining({
        failureKind: 'product_defect',
      }),
    );
  });

  it('keeps origin failures out of the product attempt budget', async () => {
    mockRunBuildAndOriginGate.mockResolvedValue({
      ok: false,
      error: 'Origin push not verified: authentication failed',
      signals: {
        origin: {
          ok: false,
          error: 'authentication failed',
          failureKind: 'auth',
        },
      },
    });

    await expect(runAppGate(input)).resolves.toEqual(
      expect.objectContaining({
        failureKind: 'infrastructure_unavailable',
        infrastructureFailure: true,
        disposition: 'unknown',
      }),
    );
  });

  it('keeps pre-push build failures in the product budget', async () => {
    mockRunBuildAndOriginGate.mockResolvedValue({
      ok: false,
      error: 'Pre-push build failed',
      signals: {
        origin: {
          ok: false,
          error: 'TypeScript compilation failed',
          failureKind: 'pre_push_build',
        },
      },
    });

    await expect(runAppGate(input)).resolves.toEqual(
      expect.objectContaining({
        failureKind: 'product_defect',
        infrastructureFailure: false,
      }),
    );
  });
});
