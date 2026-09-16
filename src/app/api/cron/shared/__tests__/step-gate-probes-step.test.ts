const mockConnect = jest.fn();
const mockRunProbes = jest.fn();
const mockRunInteractionAudit = jest.fn();
const mockApplyInteractionPolicy = jest.fn();

jest.mock('@/lib/services/sandbox-recovery', () => ({
  connectOrRecreateRequirementSandbox: mockConnect,
}));
jest.mock('@/lib/services/sandbox-service', () => ({
  SandboxService: { WORK_DIR: '/vercel/sandbox' },
}));
jest.mock('../step-gate-probes', () => ({
  runRuntimeAndVisualProbes: mockRunProbes,
}));
jest.mock('../step-interaction-runner', () => ({
  runInteractionAudit: mockRunInteractionAudit,
}));
jest.mock('../step-interaction-backlog', () => ({
  applyInteractionBacklogPolicy: mockApplyInteractionPolicy,
}));

import { runGateProbesStep } from '../step-gate-probes-step';

const passingInteraction = {
  ok: true,
  findings: [],
  blocking_count: 0,
  deferred_count: 0,
  warning_count: 0,
  summary: 'clean',
};

describe('maintenance gate probes step', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue({
      sandboxId: 'sandbox-v3',
      sandbox: {
        runCommand: jest.fn().mockResolvedValue({
          exitCode: 0,
          stdout: jest.fn().mockResolvedValue('a'.repeat(40)),
        }),
      },
    });
    mockRunInteractionAudit.mockResolvedValue(passingInteraction);
    mockApplyInteractionPolicy.mockResolvedValue(passingInteraction);
  });

  it('throws infrastructure failures so the workflow step can retry', async () => {
    mockRunProbes.mockResolvedValue({
      ok: false,
      infrastructureFailure: true,
      error: 'browser unavailable',
      signals: {},
    });

    await expect(
      runGateProbesStep({
        sandboxId: 'sandbox-v3',
        stepOrder: 0,
        requirementId: 'req-1',
        gitRepoKind: 'applications',
        instanceType: 'applications',
        title: 'Example',
      }),
    ).rejects.toThrow('browser unavailable');
  });

  it('uses the persisted baseline for interaction and visual validation', async () => {
    const baseline = 'b'.repeat(40);
    mockRunProbes.mockResolvedValue({ ok: true, signals: {} });

    const result = await runGateProbesStep({
      sandboxId: 'sandbox-v3',
      stepOrder: 0,
      requirementId: 'req-1',
      gitRepoKind: 'applications',
      instanceType: 'applications',
      title: 'Example',
      changeBaselineSha: baseline,
    });

    expect(mockRunInteractionAudit).toHaveBeenCalledWith(
      expect.anything(),
      { baselineSha: baseline },
    );
    expect(mockRunProbes).toHaveBeenCalledWith(
      expect.objectContaining({ changeBaselineSha: baseline }),
    );
    expect(result.changeBaselineSha).toBe(baseline);
    expect(result.signals.interaction).toEqual(passingInteraction);
  });
});
