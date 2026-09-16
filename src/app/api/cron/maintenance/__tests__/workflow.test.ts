import {
  cleanupNestedProjectsStep,
  commitAndPushStep,
} from '../../shared/cron-steps';
import {
  createSandboxStep,
  stopSandboxStep,
  extendRunLockStep,
  releaseRunLockStep,
} from '../../shared/cron-sandbox-lifecycle-steps';
import {
  checkInstanceAndPlanStatusStep,
  getRequirementFullContextStep,
  incrementQaSuccessfulRunsStep,
  unblockRequirementStep,
  updateInstanceStatusStep,
} from '../../shared/workflow-db-steps';
import { runGateProbesStep } from '../../shared/step-gate-probes-step';
import { runMaintenanceAgentStep } from '../agent-step';
import { runMaintenanceWorkflow } from '../workflow';

jest.mock('../../shared/cron-steps', () => ({
  cleanupNestedProjectsStep: jest.fn(),
  commitAndPushStep: jest.fn(),
}));
jest.mock('../../shared/cron-sandbox-lifecycle-steps', () => ({
  createSandboxStep: jest.fn(),
  stopSandboxStep: jest.fn(),
  extendRunLockStep: jest.fn(),
  releaseRunLockStep: jest.fn(),
}));
jest.mock('../../shared/workflow-db-steps', () => ({
  checkInstanceAndPlanStatusStep: jest.fn(),
  getRequirementFullContextStep: jest.fn(),
  incrementQaSuccessfulRunsStep: jest.fn(),
  unblockRequirementStep: jest.fn(),
  updateInstanceStatusStep: jest.fn(),
}));
jest.mock('../../shared/step-gate-probes-step', () => ({
  runGateProbesStep: jest.fn(),
}));
jest.mock('../agent-step', () => ({
  runMaintenanceAgentStep: jest.fn(),
}));
jest.mock('../prompt', () => ({
  buildMaintenancePromptForFlow: jest.fn(() => 'maintenance system prompt'),
}));
jest.mock('workflow', () => ({
  sleep: jest.fn(),
}));

const mockedCleanup = cleanupNestedProjectsStep as jest.Mock;
const mockedCommit = commitAndPushStep as jest.Mock;
const mockedCreateSandbox = createSandboxStep as jest.Mock;
const mockedStopSandbox = stopSandboxStep as jest.Mock;
const mockedExtendLock = extendRunLockStep as jest.Mock;
const mockedReleaseLock = releaseRunLockStep as jest.Mock;
const mockedCheckStatus = checkInstanceAndPlanStatusStep as jest.Mock;
const mockedGetContext = getRequirementFullContextStep as jest.Mock;
const mockedIncrementQa = incrementQaSuccessfulRunsStep as jest.Mock;
const mockedUnblock = unblockRequirementStep as jest.Mock;
const mockedUpdateStatus = updateInstanceStatusStep as jest.Mock;
const mockedRunGate = runGateProbesStep as jest.Mock;
const mockedRunAgent = runMaintenanceAgentStep as jest.Mock;

const input = {
  reqId: 'req-1',
  title: 'Repair dashboard',
  instructions: null,
  type: 'applications',
  site_id: 'site-1',
  user_id: 'user-1',
  instanceId: 'instance-1',
  previousWorkContext: '',
  instance_type: 'applications',
  maintenanceLockKey: 'maintenance:instance-1',
};

function gateResult(ok: boolean, error?: string, signals: Record<string, unknown> = {}) {
  return {
    ok,
    error,
    signals,
    effectiveSandboxId: 'sandbox-1',
    changeBaselineSha: 'baseline-sha',
  };
}

describe('maintenance workflow post-gate repairs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCheckStatus.mockResolvedValue({
      isPaused: false,
      hasActivePlan: false,
    });
    mockedCreateSandbox.mockResolvedValue({
      sandboxId: 'sandbox-1',
      branchName: 'repair-dashboard',
      workDir: '/vercel/sandbox',
    });
    mockedCleanup.mockResolvedValue({ effectiveSandboxId: 'sandbox-1' });
    mockedGetContext.mockResolvedValue({
      previousWorkContext: '',
      backlog: [],
      progress: null,
      agentBackground: '',
      memoriesContext: '',
      historyContext: '',
      instanceContext: '',
    });
    mockedRunAgent.mockResolvedValue({
      timedOut: false,
      effectiveSandboxId: 'sandbox-1',
    });
    mockedCommit.mockResolvedValue({
      pushed: true,
      effectiveSandboxId: 'sandbox-1',
    });
    mockedStopSandbox.mockResolvedValue(undefined);
    mockedExtendLock.mockResolvedValue(undefined);
    mockedReleaseLock.mockResolvedValue(undefined);
    mockedIncrementQa.mockResolvedValue(undefined);
    mockedUnblock.mockResolvedValue(undefined);
    mockedUpdateStatus.mockResolvedValue(undefined);
  });

  it('feeds a failed post-gate back to the agent before pushing', async () => {
    mockedRunGate
      .mockResolvedValueOnce(gateResult(true))
      .mockResolvedValueOnce(gateResult(
        false,
        'The dashboard button is inert',
        {
          console: {
            ok: false,
            entries: [],
            page_errors: [],
            failed_requests: [{
              url: 'https://api.example.test/data?token=secret-token',
              status: 500,
              route: '/dashboard',
              viewport: 'desktop',
            }],
          },
        },
      ))
      .mockResolvedValueOnce(gateResult(true));

    await runMaintenanceWorkflow(input);

    expect(mockedRunAgent).toHaveBeenCalledTimes(2);
    expect(mockedRunAgent.mock.calls[1][0].initialMessage).toContain(
      'The dashboard button is inert',
    );
    expect(mockedRunAgent.mock.calls[1][0].initialMessage).toContain(
      'failed_requests: 1',
    );
    expect(mockedRunAgent.mock.calls[1][0].initialMessage).toContain(
      'token=%5BREDACTED%5D',
    );
    expect(mockedRunAgent.mock.calls[1][0].initialMessage).not.toContain(
      'secret-token',
    );
    expect(mockedRunGate).toHaveBeenCalledTimes(3);
    expect(mockedCommit).toHaveBeenCalledTimes(1);
    expect(mockedCommit.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockedRunGate.mock.invocationCallOrder[2],
    );
  });

  it('caps repair attempts and never pushes a failing tree', async () => {
    mockedRunGate
      .mockResolvedValueOnce(gateResult(true))
      .mockResolvedValue(gateResult(false, 'The dashboard button is inert'));

    await expect(runMaintenanceWorkflow(input)).rejects.toThrow(
      'The dashboard button is inert',
    );

    expect(mockedRunAgent).toHaveBeenCalledTimes(3);
    expect(mockedRunGate).toHaveBeenCalledTimes(4);
    expect(mockedCommit).not.toHaveBeenCalled();
  });
});
